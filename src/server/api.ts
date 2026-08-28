import type { IncomingMessage, ServerResponse } from "node:http";
import { CAPABILITIES } from "../guards.js";
import { InsufficientChipsError } from "../types.js";
import { validateCredentials } from "./auth.js";
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

export interface ApiOptions {
  /** Where a player's session token is required. */
  readonly store: Store;
}

/**
 * The play-money HTTP API.
 *
 * Every response is JSON. Authentication is a bearer token from `/api/login` or
 * `/api/register`; there are no cookies, so nothing here is exposed to CSRF.
 */
export function createApi(store: Store) {
  async function requireUser(ctx: Ctx): Promise<User | null> {
    if (!ctx.token) {
      send(ctx.res, 401, { error: "Sign in to do that." });
      return null;
    }
    const user = store.userForToken(ctx.token);
    if (!user) {
      send(ctx.res, 401, { error: "Your session has expired. Sign in again." });
      return null;
    }
    return user;
  }

  async function me(user: User) {
    return {
      username: user.username,
      balance: store.balanceOfUser(user.username),
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
      const { username, password } = ctx.body;
      const problem = validateCredentials(username, password);
      if (problem) return send(ctx.res, 400, { error: problem });
      try {
        const { user, token } = store.register(username as string, password as string);
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
      try {
        const { user, token } = store.login(username, password);
        send(ctx.res, 200, { token, ...(await me(user)) });
      } catch (err) {
        if (err instanceof AuthenticationError) {
          return send(ctx.res, 401, { error: "Incorrect username or password." });
        }
        throw err;
      }
    },

    "POST /api/logout": async (ctx) => {
      if (ctx.token) store.logout(ctx.token);
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
        const result = store.claimFaucet(user);
        send(ctx.res, 200, { ...result, ...(await me(store.refresh(user))) });
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
      const stake = chipsFrom(ctx.body["stake"]);
      if (stake === null) {
        return send(ctx.res, 400, { error: "Stake must be a whole number of chips, at least 1." });
      }
      if (typeof ctx.body["clientSeed"] === "string" && ctx.body["clientSeed"]) {
        store.setClientSeed(user, (ctx.body["clientSeed"] as string).slice(0, 64));
      }
      try {
        const outcome = await store.bet(store.refresh(user), stake);
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
      send(ctx.res, 200, { entries: store.ledgerFor(user.username) });
    },

    "POST /api/fairness/client-seed": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      const seed = ctx.body["clientSeed"];
      if (typeof seed !== "string" || !seed.trim()) {
        return send(ctx.res, 400, { error: "Provide a seed." });
      }
      store.setClientSeed(user, seed.trim().slice(0, 64));
      send(ctx.res, 200, await me(store.refresh(user)));
    },

    "POST /api/fairness/reveal": async (ctx) => {
      const user = await requireUser(ctx);
      if (!user) return;
      send(ctx.res, 200, await store.revealAndRotate(user));
    },

    "GET /api/leaderboard": async (ctx) => {
      send(ctx.res, 200, { players: store.leaderboard() });
    },

    "GET /api/health": async (ctx) => {
      try {
        store.assertHealthy();
        send(ctx.res, 200, { ok: true });
      } catch (err) {
        send(ctx.res, 500, { ok: false, error: (err as Error).message });
      }
    },
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (!path.startsWith("/api/")) return false;

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
      await route({ req, res, body, token: bearer(req) });
    } catch (err) {
      // Report that something broke without handing the client internals.
      console.error(`${req.method} ${path} failed:`, err);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on our side." });
    }
    return true;
  };
}
