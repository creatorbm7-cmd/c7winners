/**
 * A typed client for the play-money API, for a front end that is not this one.
 *
 * The server ships its own page, and that page talks to the API over relative
 * paths. This exists for the other case: an app built and deployed elsewhere
 * that wants the same twelve endpoints without rediscovering their names and
 * shapes by reading the route table.
 *
 * No dependencies, no framework, no globals touched. It keeps the session token
 * in memory and hands it back, so where a token is stored between page loads
 * stays the caller's decision.
 *
 * There is nothing here for deposits, withdrawals, wallets or payouts, because
 * the API has no such endpoint. See src/guards.ts.
 */

/** Everything a screen needs to render the signed-in player. */
export interface Player {
  readonly username: string;
  readonly balance: number;
  readonly nonce: number;
  readonly clientSeed: string;
  /** 0 when the faucet is ready now, else epoch ms when it will be. */
  readonly faucetReadyAt: number;
  readonly faucetAmount: number;
  /** SHA-256 of the server seed the next rolls will use. */
  readonly commitment: string;
  readonly rules: GameRules;
  readonly capabilities: Capabilities;
}

export interface GameRules {
  readonly winChance: number;
  readonly houseEdge: number;
}

export interface Capabilities {
  readonly mode: string;
  readonly currency: string;
  readonly realMoneyEngine: boolean;
  readonly deposits: boolean;
  readonly withdrawals: boolean;
  readonly cashOut: boolean;
  readonly requiresGamingLicence: boolean;
  readonly requiresPaymentProcessor: boolean;
}

export interface Session extends Player {
  readonly token: string;
}

export interface FaucetResult extends Player {
  readonly granted: number;
  readonly nextClaimAt: number;
}

/** One settled round. The server decided all of it before replying. */
export interface BetOutcome {
  readonly won: boolean;
  /** Uniform in [0, 1). The round was won when it fell below `winChance`. */
  readonly roll: number;
  readonly stake: number;
  readonly payout: number;
  readonly net: number;
  readonly nonce: number;
  readonly balance: number;
}

export interface LedgerRow {
  readonly seq: number;
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  /** `faucet`, `bet` or `payout`. */
  readonly reason: string;
}

export interface LeaderboardRow {
  readonly username: string;
  readonly balance: number;
  readonly rounds: number;
}

export interface PlatformStatus {
  readonly capabilities: Capabilities;
  readonly rules: GameRules;
  readonly build?: { readonly commit?: string };
  readonly cors: { readonly allowedOrigins: readonly string[] };
  readonly storage?: { readonly engine: string; readonly createdThisBoot: boolean };
  readonly chipsInCirculation: number;
  readonly housePosition: number;
  readonly playerChips: number;
  readonly ledgerEntries: number;
  readonly players: number;
  readonly booksReconcile: boolean;
  readonly negativeAccounts: number;
}

/**
 * A refusal from the API, carrying what the server said about it.
 *
 * The extra fields are the ones a screen actually needs: `balance` to show what
 * a player has when a stake was too large, `nextClaimAt` to run a faucet
 * countdown, `retryAfterMs` to say how long a rate limit lasts. Dropping them
 * would leave the UI guessing at numbers the server already knows.
 */
export class PlayApiError extends Error {
  readonly status: number;
  readonly balance?: number;
  readonly nextClaimAt?: number;
  readonly retryAfterMs?: number;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body["error"] === "string" ? body["error"] : `Request failed (${status})`);
    this.name = "PlayApiError";
    this.status = status;
    if (typeof body["balance"] === "number") this.balance = body["balance"];
    if (typeof body["nextClaimAt"] === "number") this.nextClaimAt = body["nextClaimAt"];
    if (typeof body["retryAfterMs"] === "number") this.retryAfterMs = body["retryAfterMs"];
  }
}

export interface PlayApiOptions {
  /**
   * Where the API lives. Relative (`/api`) whenever the page and the API share
   * an origin, which is the arrangement that needs no CORS at all. An absolute
   * URL works only if the server lists this page's origin in ALLOWED_ORIGINS.
   */
  readonly baseUrl?: string;
  /** A token from an earlier session, if the caller kept one. */
  readonly token?: string | null;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export class PlayApi {
  #baseUrl: string;
  #token: string | null;
  #fetch: typeof globalThis.fetch;

  constructor(options: PlayApiOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.#token = options.token ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The current session token, or null. Persist it if you want to. */
  get token(): string | null {
    return this.#token;
  }

  set token(value: string | null) {
    this.#token = value;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    const payload = (parsed ?? {}) as Record<string, unknown>;
    if (!res.ok) throw new PlayApiError(res.status, payload);
    return payload as T;
  }

  /* ---------- session ---------- */

  async register(username: string, password: string): Promise<Session> {
    const session = await this.#call<Session>("POST", "/register", { username, password });
    this.#token = session.token;
    return session;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.#call<Session>("POST", "/login", { username, password });
    this.#token = session.token;
    return session;
  }

  /** Ends the session server-side and forgets the token here. */
  async logout(): Promise<void> {
    await this.#call<{ ok: true }>("POST", "/logout");
    this.#token = null;
  }

  me(): Promise<Player> {
    return this.#call<Player>("GET", "/me");
  }

  /* ---------- chips ---------- */

  faucet(): Promise<FaucetResult> {
    return this.#call<FaucetResult>("POST", "/faucet");
  }

  /**
   * Plays one round for `stake` chips.
   *
   * A whole number, at least 1: the server rejects `"100"` and `10.5` rather
   * than rounding them into something plausible. Passing `clientSeed` sets the
   * seed before the roll, so a player can change it and bet in one action.
   */
  bet(stake: number, clientSeed?: string): Promise<BetOutcome> {
    return this.#call<BetOutcome>("POST", "/bet", {
      stake,
      ...(clientSeed === undefined ? {} : { clientSeed }),
    });
  }

  async ledger(): Promise<LedgerRow[]> {
    const { entries } = await this.#call<{ entries: LedgerRow[] }>("GET", "/ledger");
    return entries;
  }

  /* ---------- provable fairness ---------- */

  setClientSeed(clientSeed: string): Promise<Player> {
    return this.#call<Player>("POST", "/fairness/client-seed", { clientSeed });
  }

  /** Reveals the seed past rolls used and starts a new one. Resets the nonce. */
  revealAndRotate(): Promise<{ revealedSeed: string; commitment: string }> {
    return this.#call("POST", "/fairness/reveal");
  }

  /* ---------- public ---------- */

  async leaderboard(): Promise<LeaderboardRow[]> {
    const { players } = await this.#call<{ players: LeaderboardRow[] }>("GET", "/leaderboard");
    return players;
  }

  status(): Promise<PlatformStatus> {
    return this.#call<PlatformStatus>("GET", "/status");
  }

  async healthy(): Promise<boolean> {
    try {
      const { ok } = await this.#call<{ ok: boolean }>("GET", "/health");
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Reel faces to display for a settled round.
 *
 * A slot is presentation over a decision the server already made, so the reels
 * have to depict that decision rather than reach one of their own: matching
 * faces when the round was won, deliberately non-matching when it was lost.
 * The faces come from the roll, so the same round always shows the same reels —
 * a replay, a reconnect and a screenshot all agree.
 *
 * `faces` is how many distinct symbols the strip has; `reels` how many columns.
 */
export function reelFaces(outcome: BetOutcome, faces = 8, reels = 3): number[] {
  if (faces < 2) throw new Error("A reel needs at least two faces");
  if (reels < 1) throw new Error("A slot needs at least one reel");
  // 48 bits of roll, spread across the columns without reusing the same digits.
  const seed = Math.floor(outcome.roll * 2 ** 48);
  const digit = (index: number) => Math.floor(seed / faces ** index) % faces;

  const first = digit(0);
  if (outcome.won) return Array.from({ length: reels }, () => first);

  const shown = Array.from({ length: reels }, (_, i) => digit(i));
  // A loss that happens to line up would be read as a win the payout contradicts.
  if (reels > 1 && shown.every((face) => face === shown[0])) {
    shown[reels - 1] = (shown[reels - 1]! + 1) % faces;
  }
  return shown;
}
