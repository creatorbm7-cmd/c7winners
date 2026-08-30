import type { IncomingMessage, ServerResponse } from "node:http";
import { CAPABILITIES } from "../guards.js";
import { InsufficientChipsError } from "../types.js";
import { validateCredentials } from "./auth.js";
import { RateLimiter, clientAddress, type BucketConfig } from "./ratelimit.js";
import {
  AuthenticationError,
  FaucetCooldownError,
  Store,
  UsernameTakenError,
  type User,
} from "./store.js";

/** Largest request body accepted, so a hostile client cannot exhaust memory. */
const MAX_BODY_BYTES = 4096;

interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: Record<string, unknown>;
  readonly token: string | null;
  /** The caller's address, as far as it can be trusted. */
  readonly ip: string;
}

export interface RateLimitConfig {
  /** Applies to every request, so no single caller can flood the server. */
  readonly global?: BucketConfig;
  /** Account creation, per address. */
  readonly register?: BucketConfig;
  /** Sign-in attempts, per address. */
  readonly login?: BucketConfig;
  /** Sign-in attempts against one username, from anywhere. */
  readonly loginPerUser?: BucketConfig;
  /** Bets, per signed-in player. */
  readonly bet?: BucketConfig;
}

/**
 * Defaults sized so a real player never meets them.
 *
 * The sign-in limits are the load-bearing ones: they are what stops a password
 * from being guessed at machine speed. `loginPerUser` exists because limiting by
 * address alone leaves one account open to a slow attempt from each of many
 * addresses.
 */
export const DEFAULT_RATE_LIMITS: Required<RateLimitConfig> = {
  global: { capacity: 300, refillMs: 60_000 },
  register: { capacity: 5, refillMs: 60 * 60_000 },
  login: { capacity: 10, refillMs: 15 * 60_000 },
  loginPerUser: { capacity: 5, refillMs: 15 * 60_000 },
  bet: { capacity: 120, refillMs: 60_000 },
};

export interface ApiConfig {
  readonly rateLimits?: RateLimitConfig;
  /**
   * How many proxies in front of this server are yours.
   *
   * Left at 0, `X-Forwarded-For` is ignored entirely — the safe default, since a
   * client can put anything in that header and would otherwise get a fresh
   * rate-limit identity on every request. Set it to the real number of hops only
   * when this server sits behind proxies you control.
   */
  readonly trustedProxies?: number;
  readonly clock?: () => number;
  /**
   * Whether accounts written now will still be here after the next deploy.
   *
   * SQLite on a container filesystem loses everything on redeploy, and loses it
   * quietly: the server starts, the health check passes, and the only sign is
   * that the players are gone. So the deployment tells the API what it knows,
   * and /api/status says it out loud.
   */
  readonly storage?: StorageFacts;
  /**
   * Browser origins allowed to call this API from a page they serve.
   *
   * Empty — the default — means no CORS surface at all: the front end this
   * server serves is same-origin, so it needs none, and a page anywhere else
   * cannot read a response it gets. Listing an origin here lets exactly that
   * origin's pages read replies, which is what a front end deployed separately
   * needs. Exact origins only, and no wildcard: echoing back whatever origin
   * asked is how a hostile page gets to read a signed-in player's data.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Which build is running, when the platform is willing to say.
   *
   * Reported so that "is the code I merged actually live?" can be answered from
   * outside, by anyone, without a dashboard login. Every other way of asking
   * that question needs access to the host.
   */
  readonly build?: BuildFacts;
}

export interface BuildFacts {
  /** The commit this process was built from, or undefined if unknown. */
  readonly commit?: string;
}

export interface StorageFacts {
  readonly engine: "sqlite" | "postgres";
  /**
   * SQLite only: no database file existed when this process started.
   *
   * True on a genuinely first deploy, and true again after every deploy when the
   * file is not on a volume — which is the case worth catching, since the two
   * look identical from outside until the second one happens twice.
   */
  readonly createdThisBoot: boolean;
}

/**
 * The origins from a comma-separated list, refusing anything that is not one.
 *
 * A misspelled entry would otherwise fail silently — the header simply never
 * matches — and the only symptom would be a CORS error in someone's browser,
 * with nothing in the deploy log to explain it. Better to not start.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(
        `${JSON.stringify(entry)} is not an origin. ` +
          `Write it like https://c7winners.com — scheme and host, nothing else.`,
      );
    }
    if (parsed.origin !== entry) {
      throw new Error(
        `Use the origin alone — ${JSON.stringify(parsed.origin)}, not ${JSON.stringify(entry)}. ` +
          `A path, a trailing slash or a wildcard never matches.`,
      );
    }
  }
  return entries;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * A positive whole number of chips from untrusted input, or null.
 *
 * Rejects rather than coerces: `"100"`, `1e400` and `10.5` are all mistakes worth
 * reporting, not values to round into something plausible.
 */
function chipsFrom(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * The play-money HTTP API.
 *
 * Every response is JSON. Authentication is a bearer token from `/api/login` or
 * `/api/register`; there are no cookies, so nothing here is exposed to CSRF.
 */
export function createApi(store: Store, config: ApiConfig = {}) {
  const limits = { ...DEFAULT_RATE_LIMITS, ...config.rateLimits };
  const trustedProxies = config.trustedProxies ?? 0;
  const clock = config.clock ?? Date.now;
  const storage = config.storage;
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  const build = config.build;
  /**
   * When this process came up.
   *
   * Two readings carrying the same value came from the same process, so
   * "did the deployment I just triggered actually replace the running one?"
   * is answerable from outside without writing anything to the database.
   * Without it, a redeploy that changes no visible setting is invisible.
   */
  const startedAt = clock();
  const limiter = {
    global: new RateLimiter(limits.global, clock),
    register: new RateLimiter(limits.register, clock),
    login: new RateLimiter(limits.login, clock),
    loginPerUser: new RateLimiter(limits.loginPerUser, clock),
    bet: new RateLimiter(limits.bet, clock),
  };

  /** Refuses with 429 and a Retry-After, or returns true to continue. */
  function withinLimit(res: ServerResponse, rl: RateLimiter, key: string, what: string): boolean {
    const decision = rl.take(key);
    if (decision.allowed) return true;
    const seconds = Math.ceil(decision.retryAfterMs / 1000);
    res.setHeader("retry-after", String(seconds));
    send(res, 429, {
      error: `Too many ${what}. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      retryAfterMs: decision.retryAfterMs,
    });
    return false;
  }

  /**
   * Lets one listed origin read this response, or leaves it unreadable.
   *
   * Echoes the caller's own origin rather than a wildcard, so the header names
   * exactly one origin and `vary` keeps a cache from handing one origin's copy
   * to another. Nothing is sent for an origin that is not listed, or when the
   * list is empty — the browser then blocks the response, which is the point.
   *
   * No `access-control-allow-credentials`: authentication here is a bearer
   * token the page attaches deliberately, so cookies never need to ride along.
   */
  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) return;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }

  async function requireUser(ctx: Ctx): Promise<User | null> {
    if (!ctx.token) {
      send(ctx.res, 401, { error: "Sign in to do that." });
      return null;
    }
    const user = await store.userForToken(ctx.token);
    if (!user) {
      send(ctx.res, 401, { error: "Your session has expired. Sign in again." });
      return null;
    }
    return user;
  }

  async function me(user: User) {
    return {
      username: user.username,
      balance: await store.balanceOfUser(user.username),
      nonce: user.nonce,
      clientSeed: user.clientSeed,
      faucetReadyAt: store.faucetReadyAt(user),
      faucetAmount: store.faucetAmount,
      commitment: await store.commitmentFor(user),
      rules: store.rules,
      capabilities: CAPABILITIES,
    };
  }

  const routes: Record<string, (ctx: Ctx) => Promise<void>> = {
    "POST /api/register": async (ctx) => {
      if (!withinLimit(ctx.res, limiter.register, ctx.ip, "new accounts from here")) return;
      const { username, password } = ctx.body;
      const problem = validateCredentials(username, password);
      if (problem) return send(ctx.res, 400, { error: problem });
      try {
        const { user, token } = await store.register(username as string, password as string);
        send(ctx.res, 201, { token, ...(await me(user)) });
      } catch (err) {
        if (err instanceof UsernameTakenError) {
          return send(ctx.res, 409, { error: "That username is taken." });
        }
        throw err;
      }
    },

    "POST /api/login": async (ctx) => {
      const { username, password } = ctx.body;
      if (typeof username !== "string" || typeof password !== "string") {
        return send(ctx.res, 400, { error: "Username and password are required." });
      }
      if (!withinLimit(ctx.res, limiter.login, ctx.ip, "sign-in attempts")) return;
      const userKey = username.toLowerCase();
      if (!withinLimit(ctx.res, limiter.loginPerUser, userKey, "sign-in attempts for that account")) {
        return;
      }
      try {
        const { user, token } = await store.login(username, password);
        // A correct password should not count against the limit: the point is to
        // slow guessing, not to lock out someone who signed in successfully.
        limiter.login.refund(ctx.ip);
        limiter.loginPerUser.refund(userKey);
        send(ctx.res, 200, { token, ...(await me(user)) });
      } catch (err) {
        if (err instanceof AuthenticationError) {
          return send(ctx.res, 401, { error: "Incorrect username or password." });
        }
        throw err;
      }
    },

    "POST /api/logout": async (ctx) => {
      if (ctx.token) await store.logout(ctx.token);
      send(ctx.res, 200, { ok: true });
    },

    "GET /api/me": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      send(ctx.res, 200, await me(user));
    },

    "POST /api/faucet": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      try {
        const result = await store.claimFaucet(user);
        send(ctx.res, 200, { ...result, ...(await me(await store.refresh(user))) });
      } catch (err) {
        if (err instanceof FaucetCooldownError) {
          return send(ctx.res, 429, {
            error: "You have already claimed recently.",
            nextClaimAt: err.nextClaimAt,
          });
        }
        throw err;
      }
    },

    "POST /api/bet": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      if (!withinLimit(ctx.res, limiter.bet, user.username, "bets")) return;
      const stake = chipsFrom(ctx.body["stake"]);
      if (stake === null) {
        return send(ctx.res, 400, { error: "Stake must be a whole number of chips, at least 1." });
      }
      if (typeof ctx.body["clientSeed"] === "string" && ctx.body["clientSeed"]) {
        await store.setClientSeed(user, (ctx.body["clientSeed"] as string).slice(0, 64));
      }
      try {
        const outcome = await store.bet(await store.refresh(user), stake);
        send(ctx.res, 200, outcome);
      } catch (err) {
        if (err instanceof InsufficientChipsError) {
          return send(ctx.res, 400, {
            error: `You only have ${err.balance} chips.`,
            balance: err.balance,
          });
        }
        throw err;
      }
    },

    "GET /api/ledger": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      send(ctx.res, 200, { entries: await store.ledgerFor(user.username) });
    },

    "POST /api/fairness/client-seed": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      const seed = ctx.body["clientSeed"];
      if (typeof seed !== "string" || !seed.trim()) {
        return send(ctx.res, 400, { error: "Provide a seed." });
      }
      await store.setClientSeed(user, seed.trim().slice(0, 64));
      send(ctx.res, 200, await me(await store.refresh(user)));
    },

    "POST /api/fairness/reveal": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      send(ctx.res, 200, await store.revealAndRotate(user));
    },

    "GET /api/leaderboard": async (ctx) => {
      send(ctx.res, 200, { players: await store.leaderboard() });
    },

    /**
     * The house at a glance: what this build can do, and what it is holding.
     *
     * Public and aggregate — no usernames, no per-player figures — because the
     * claim it exists to support ("nothing here moves real money") is one anyone
     * should be able to check without an account.
     */
    "GET /api/status": async (ctx) => {
      send(ctx.res, 200, {
        capabilities: CAPABILITIES,
        rules: store.rules,
        // Configuration a deployment is easy to get wrong and impossible to
        // check from outside: which build is live, and who may call this API
        // from a page. Neither is a secret — the second is discoverable by
        // asking with an Origin header — and saying them plainly turns a
        // dashboard hunt into one request.
        ...(build === undefined ? {} : { build }),
        startedAt,
        cors: { allowedOrigins: [...allowedOrigins] },
        ...(storage === undefined ? {} : { storage }),
        ...(await store.status()),
      });
    },

    "GET /api/health": async (ctx) => {
      try {
        await store.assertHealthy();
        send(ctx.res, 200, { ok: true });
      } catch (err) {
        send(ctx.res, 500, { ok: false, error: (err as Error).message });
      }
    },
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!path.startsWith("/api/")) return false;

    // Before the rate limiter, so a 429 is one the calling page can read and
    // report rather than one the browser hides behind a CORS failure.
    applyCors(req, res);

    const ip = clientAddress(req.headers["x-forwarded-for"], req.socket.remoteAddress, trustedProxies);
    if (!withinLimit(res, limiter.global, ip, "requests")) return true;

    if (req.method === "OPTIONS") {
      const asking = String(req.headers["access-control-request-method"] ?? "").toUpperCase();
      // Answered only for an allowed origin asking about a route that exists, so
      // a preflight cannot be used to map the surface from anywhere else.
      if (res.hasHeader("access-control-allow-origin") && routes[`${asking} ${path}`]) {
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        res.setHeader("access-control-max-age", "600");
        res.writeHead(204).end();
        return true;
      }
      send(res, 404, { error: "No such endpoint." });
      return true;
    }

    const route = routes[`${req.method ?? "GET"} ${path}`];
    if (!route) {
      send(res, 404, { error: "No such endpoint." });
      return true;
    }

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        send(res, 400, { error: (err as Error).message });
        return true;
      }
    }

    try {
      await route({ req, res, body, token: bearer(req), ip });
    } catch (err) {
      // Report that something broke without handing the client internals.
      console.error(`${req.method} ${path} failed:`, err);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on our side." });
    }
    return true;
  };
}
