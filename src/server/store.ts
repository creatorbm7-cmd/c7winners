import type { DatabaseSync } from "node:sqlite";
import { HOUSE, MINT, playerAccount } from "../accounts.js";
import { COIN_FLIP, commitment, generateServerSeed, roll, settle, type GameRules } from "../game.js";
import { assertChips, InsufficientChipsError, type Chips } from "../types.js";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./auth.js";

export interface User {
  readonly id: number;
  readonly username: string;
  readonly nonce: number;
  readonly clientSeed: string;
  readonly lastClaim: number;
}

export interface LedgerRow {
  readonly seq: number;
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly amount: Chips;
  readonly reason: string;
}

export interface BetOutcome {
  readonly won: boolean;
  readonly roll: number;
  readonly stake: Chips;
  readonly payout: Chips;
  readonly net: number;
  readonly nonce: number;
  readonly balance: Chips;
}

export interface LeaderboardRow {
  readonly username: string;
  readonly balance: Chips;
  readonly rounds: number;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken`);
    this.name = "UsernameTakenError";
  }
}

export class AuthenticationError extends Error {
  constructor() {
    super("Incorrect username or password");
    this.name = "AuthenticationError";
  }
}

export class FaucetCooldownError extends Error {
  constructor(readonly nextClaimAt: number) {
    super("Faucet is still on cooldown");
    this.name = "FaucetCooldownError";
  }
}

export interface StoreOptions {
  readonly faucetAmount?: Chips;
  readonly faucetCooldownMs?: number;
  readonly sessionTtlMs?: number;
  readonly rules?: GameRules;
  readonly clock?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Multi-user play-money store, backed by SQLite.
 *
 * The game rules come from the same modules the single-process casino uses; only
 * storage differs. Balances are a SUM over the append-only entry log rather than
 * a column, so the property the in-memory ledger guarantees by construction is
 * guaranteed here by the schema.
 */
export class Store {
  readonly #db: DatabaseSync;
  readonly #faucetAmount: Chips;
  readonly #faucetCooldownMs: number;
  readonly #sessionTtlMs: number;
  readonly #rules: GameRules;
  readonly #clock: () => number;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.#db = db;
    this.#faucetAmount = options.faucetAmount ?? 1000;
    this.#faucetCooldownMs = options.faucetCooldownMs ?? 60_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * DAY_MS;
    this.#rules = options.rules ?? COIN_FLIP;
    this.#clock = options.clock ?? Date.now;
  }

  get faucetAmount(): Chips {
    return this.#faucetAmount;
  }

  get faucetCooldownMs(): number {
    return this.#faucetCooldownMs;
  }

  get rules(): GameRules {
    return this.#rules;
  }

  /* ---------- accounts ---------- */

  register(username: string, password: string): { user: User; token: string } {
    const { hash, salt } = hashPassword(password);
    const now = this.#clock();
    try {
      this.#db
        .prepare(
          `INSERT INTO users (username, password_hash, salt, created_at, server_seed, client_seed)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(username, hash, salt, now, generateServerSeed(), generateServerSeed(8));
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new UsernameTakenError(username);
      throw err;
    }
    const user = this.#requireUserByName(username);
    return { user, token: this.#createSession(user.id) };
  }

  login(username: string, password: string): { user: User; token: string } {
    const row = this.#db
      .prepare(`SELECT id, username, password_hash, salt, nonce, client_seed, last_claim
                FROM users WHERE username = ?`)
      .get(username) as Record<string, unknown> | undefined;
    // Hash even when the user does not exist, so a missing account and a wrong
    // password take the same time and cannot be told apart by timing.
    const record = row
      ? { hash: String(row["password_hash"]), salt: String(row["salt"]) }
      : { hash: "00".repeat(64), salt: "0".repeat(32) };
    const ok = verifyPassword(password, record);
    if (!row || !ok) throw new AuthenticationError();
    const user = this.#toUser(row);
    return { user, token: this.#createSession(user.id) };
  }

  /** The user a session token belongs to, or null when it is unknown or expired. */
  userForToken(token: string): User | null {
    const row = this.#db
      .prepare(
        `SELECT u.id, u.username, u.nonce, u.client_seed, u.last_claim, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashSessionToken(token)) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (Number(row["expires_at"]) <= this.#clock()) {
      this.logout(token);
      return null;
    }
    return this.#toUser(row);
  }

  logout(token: string): void {
    this.#db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashSessionToken(token));
  }

  #createSession(userId: number): string {
    const token = generateSessionToken();
    const now = this.#clock();
    this.#db
      .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)`)
      .run(hashSessionToken(token), userId, now, now + this.#sessionTtlMs);
    return token;
  }

  #requireUserByName(username: string): User {
    const row = this.#db
      .prepare(`SELECT id, username, nonce, client_seed, last_claim FROM users WHERE username = ?`)
      .get(username) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`User ${username} vanished immediately after insert`);
    return this.#toUser(row);
  }

  #toUser(row: Record<string, unknown>): User {
    return {
      id: Number(row["id"]),
      username: String(row["username"]),
      nonce: Number(row["nonce"] ?? 0),
      clientSeed: String(row["client_seed"] ?? ""),
      lastClaim: Number(row["last_claim"] ?? 0),
    };
  }

  /* ---------- ledger ---------- */

  /** An account's balance, summed from the entry log. Never a stored column. */
  balanceOf(account: string): Chips {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(
           (SELECT SUM(amount) FROM entries WHERE to_account = ?1), 0
         ) - COALESCE(
           (SELECT SUM(amount) FROM entries WHERE from_account = ?1), 0
         ) AS balance`,
      )
      .get(account) as { balance: number };
    return Number(row.balance);
  }

  balanceOfUser(username: string): Chips {
    return this.balanceOf(playerAccount(username));
  }

  #post(from: string, to: string, amount: Chips, reason: string): void {
    assertChips(amount);
    this.#db
      .prepare(`INSERT INTO entries (at, from_account, to_account, amount, reason) VALUES (?,?,?,?,?)`)
      .run(this.#clock(), from, to, amount, reason);
  }

  /** Recent entries touching this user, newest first. */
  ledgerFor(username: string, limit = 25): LedgerRow[] {
    const account = playerAccount(username);
    const rows = this.#db
      .prepare(
        `SELECT seq, at, from_account, to_account, amount, reason FROM entries
         WHERE from_account = ?1 OR to_account = ?1
         ORDER BY seq DESC LIMIT ?2`,
      )
      .all(account, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r["seq"]),
      at: Number(r["at"]),
      from: String(r["from_account"]),
      to: String(r["to_account"]),
      amount: Number(r["amount"]),
      reason: String(r["reason"]),
    }));
  }

  /**
   * Throws unless the books are sound.
   *
   * There is deliberately no zero-sum check: every row carries both a `from` and
   * a `to`, so the books sum to zero structurally and asserting it would only
   * ever confirm the schema. The claim that can actually fail is that no player
   * holds chips their own history never gave them.
   */
  assertHealthy(): void {
    const negative = this.#db
      .prepare(
        `SELECT a.account AS account FROM (
           SELECT to_account AS account FROM entries
           UNION SELECT from_account FROM entries
         ) a
         WHERE a.account LIKE 'player:%'
           AND (COALESCE((SELECT SUM(amount) FROM entries WHERE to_account = a.account), 0)
              - COALESCE((SELECT SUM(amount) FROM entries WHERE from_account = a.account), 0)) < 0
         LIMIT 1`,
      )
      .get() as { account?: string } | undefined;
    if (negative?.account) {
      throw new Error(`Player account ${negative.account} is negative`);
    }
  }

  /* ---------- gameplay ---------- */

  faucetReadyAt(user: User): number {
    const next = user.lastClaim + this.#faucetCooldownMs;
    return next > this.#clock() ? next : 0;
  }

  claimFaucet(user: User): { granted: Chips; balance: Chips; nextClaimAt: number } {
    const blocked = this.faucetReadyAt(user);
    if (blocked !== 0) throw new FaucetCooldownError(blocked);
    const now = this.#clock();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#post(MINT, playerAccount(user.username), this.#faucetAmount, "faucet");
      this.#db.prepare(`UPDATE users SET last_claim = ? WHERE id = ?`).run(now, user.id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return {
      granted: this.#faucetAmount,
      balance: this.balanceOfUser(user.username),
      nextClaimAt: now + this.#faucetCooldownMs,
    };
  }

  /**
   * Places one bet.
   *
   * The roll is computed from a seed the client never sees, so unlike a
   * browser-only build the commitment is a real promise: the server fixed the
   * outcome before the bet and can be checked against it afterwards.
   */
  async bet(user: User, stake: Chips): Promise<BetOutcome> {
    assertChips(stake);
    const account = playerAccount(user.username);
    const balance = this.balanceOf(account);
    if (balance < stake) throw new InsufficientChipsError(account, balance, stake);

    const row = this.#db
      .prepare(`SELECT server_seed, client_seed, nonce FROM users WHERE id = ?`)
      .get(user.id) as Record<string, unknown>;
    const nonce = Number(row["nonce"]);
    const rolled = await roll(String(row["server_seed"]), String(row["client_seed"]), nonce);
    const outcome = settle(rolled, stake, this.#rules);

    // Both legs and the nonce move together: a crash between them would either
    // charge a stake with no round, or let the same nonce be replayed.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#post(account, HOUSE, stake, "bet");
      if (outcome.payout > 0) this.#post(HOUSE, account, outcome.payout, "payout");
      this.#db.prepare(`UPDATE users SET nonce = nonce + 1 WHERE id = ?`).run(user.id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }

    return {
      won: outcome.won,
      roll: outcome.roll,
      stake,
      payout: outcome.payout,
      net: outcome.payout - stake,
      nonce,
      balance: this.balanceOf(account),
    };
  }

  /* ---------- provable fairness ---------- */

  /** The published commitment for this user's current server seed. */
  async commitmentFor(user: User): Promise<string> {
    const row = this.#db.prepare(`SELECT server_seed FROM users WHERE id = ?`).get(user.id) as
      | Record<string, unknown>
      | undefined;
    return commitment(String(row?.["server_seed"] ?? ""));
  }

  /**
   * Reveals the current server seed and installs a fresh one.
   *
   * Revealing and rotating are the same operation on purpose: once a seed is
   * public, rolls made with it are predictable, so it must not be reused.
   */
  async revealAndRotate(user: User): Promise<{ revealedSeed: string; commitment: string }> {
    const row = this.#db.prepare(`SELECT server_seed FROM users WHERE id = ?`).get(user.id) as
      | Record<string, unknown>
      | undefined;
    const revealedSeed = String(row?.["server_seed"] ?? "");
    const next = generateServerSeed();
    this.#db.prepare(`UPDATE users SET server_seed = ?, nonce = 0 WHERE id = ?`).run(next, user.id);
    return { revealedSeed, commitment: await commitment(next) };
  }

  setClientSeed(user: User, seed: string): void {
    this.#db.prepare(`UPDATE users SET client_seed = ? WHERE id = ?`).run(seed, user.id);
  }

  /* ---------- leaderboard ---------- */

  leaderboard(limit = 10): LeaderboardRow[] {
    const rows = this.#db
      .prepare(
        `SELECT u.username AS username,
                COALESCE((SELECT SUM(amount) FROM entries WHERE to_account = 'player:' || u.username), 0)
              - COALESCE((SELECT SUM(amount) FROM entries WHERE from_account = 'player:' || u.username), 0) AS balance,
                (SELECT COUNT(*) FROM entries
                  WHERE from_account = 'player:' || u.username AND reason = 'bet') AS rounds
         FROM users u
         ORDER BY balance DESC, rounds DESC, u.username ASC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      username: String(r["username"]),
      balance: Number(r["balance"]),
      rounds: Number(r["rounds"]),
    }));
  }

  /** Reload a user row, picking up nonce and cooldown changes. */
  refresh(user: User): User {
    return this.#requireUserByName(user.username);
  }
}
