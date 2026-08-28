import {
  assertChips,
  InsufficientChipsError,
  type AccountId,
  type Chips,
} from "./types.js";

/** A single balanced movement of chips between two accounts. */
export interface Entry {
  /** Monotonic sequence number, starting at 1. */
  readonly seq: number;
  /** Milliseconds since epoch, from the ledger's clock. */
  readonly at: number;
  /** The account chips move out of. */
  readonly from: AccountId;
  /** The account chips move into. */
  readonly to: AccountId;
  readonly amount: Chips;
  /** Why this movement happened, e.g. `faucet`, `bet`, `payout`. */
  readonly reason: string;
}

/** Thrown when the ledger's books do not reconcile — this should be impossible. */
export class LedgerCorruptError extends Error {
  constructor(detail: string) {
    super(`Ledger does not reconcile: ${detail}`);
    this.name = "LedgerCorruptError";
  }
}

/**
 * An append-only double-entry ledger for play chips.
 *
 * Balances are *derived* from entries, never stored and updated alongside them.
 * That is the whole point: a system that keeps a running balance next to its
 * transaction log can have the two disagree, and then it will happily report
 * itself healthy while being anything but. Here the balance cannot drift,
 * because there is nothing to drift from.
 *
 * Every entry moves chips from one account to another, so the sum of all
 * balances is always exactly zero.
 */
export class Ledger {
  readonly #entries: Entry[] = [];
  readonly #balances = new Map<AccountId, Chips>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /** Every entry ever posted, oldest first. */
  get entries(): readonly Entry[] {
    return this.#entries;
  }

  /** The number of entries posted. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Chips held by an account. Player accounts are never negative; the mint runs
   * negative by the number of chips it has issued.
   */
  balanceOf(account: AccountId): Chips {
    return this.#balances.get(account) ?? 0;
  }

  /** Every account that has ever been touched, with its balance. */
  balances(): ReadonlyMap<AccountId, Chips> {
    return new Map(this.#balances);
  }

  /**
   * Move chips between two accounts.
   *
   * @param allowOverdraft - only the mint may go negative; it is how chips enter
   * circulation. Every other account must have the chips it is spending.
   */
  post(
    from: AccountId,
    to: AccountId,
    amount: Chips,
    reason: string,
    allowOverdraft = false,
  ): Entry {
    assertChips(amount);
    if (from === to) {
      throw new Error(`Cannot post an entry from ${from} to itself`);
    }

    const available = this.balanceOf(from);
    if (!allowOverdraft && available < amount) {
      throw new InsufficientChipsError(from, available, amount);
    }

    const entry: Entry = {
      seq: this.#entries.length + 1,
      at: this.#clock(),
      from,
      to,
      amount,
      reason,
    };

    this.#entries.push(entry);
    this.#balances.set(from, available - amount);
    this.#balances.set(to, this.balanceOf(to) + amount);
    return entry;
  }

  /**
   * Rebuilds the ledger from a stored entry log, recomputing every balance.
   *
   * This is the seam persistence hangs off: only the entries are ever stored,
   * and balances come back by replaying them, so a restore cannot resurrect a
   * balance that its own history does not support.
   */
  replay(entries: readonly Entry[]): void {
    this.#entries.length = 0;
    this.#balances.clear();
    for (const e of entries) {
      // Entries arrive from storage, so they get the same scrutiny post() applies
      // rather than being trusted because they were written by an earlier run.
      assertChips(e.amount);
      if (typeof e.from !== "string" || typeof e.to !== "string" || e.from === e.to) {
        throw new LedgerCorruptError(`entry ${e.seq} moves chips from ${e.from} to ${e.to}`);
      }
      this.#entries.push(e);
      this.#balances.set(e.from, this.balanceOf(e.from) - e.amount);
      this.#balances.set(e.to, this.balanceOf(e.to) + e.amount);
    }
  }

  /**
   * Recomputes every balance from the entry log and checks the books sum to zero.
   *
   * Call this in tests and health checks. Unlike a stored solvency flag, this
   * cannot report success while the underlying numbers disagree — it derives its
   * answer from the same log the balances come from.
   */
  assertBalanced(): void {
    const recomputed = new Map<AccountId, Chips>();
    for (const e of this.#entries) {
      recomputed.set(e.from, (recomputed.get(e.from) ?? 0) - e.amount);
      recomputed.set(e.to, (recomputed.get(e.to) ?? 0) + e.amount);
    }

    for (const [account, expected] of recomputed) {
      const actual = this.balanceOf(account);
      if (actual !== expected) {
        throw new LedgerCorruptError(
          `${account} reports ${actual} chips but its entries sum to ${expected}`,
        );
      }
    }

    let total = 0;
    for (const balance of recomputed.values()) total += balance;
    if (total !== 0) {
      throw new LedgerCorruptError(`accounts sum to ${total}, expected 0`);
    }
  }

  /** Chips currently in circulation, i.e. issued by the mint and not yet burned. */
  inCirculation(mint: AccountId): Chips {
    return -this.balanceOf(mint);
  }
}
