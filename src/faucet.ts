import { MINT, playerAccount } from "./accounts.js";
import type { Ledger } from "./ledger.js";
import type { Chips } from "./types.js";

export interface FaucetOptions {
  /** Chips granted per claim. */
  readonly amount: Chips;
  /** How long a player must wait between claims, in milliseconds. */
  readonly cooldownMs: number;
  readonly clock?: () => number;
}

export interface ClaimResult {
  readonly granted: Chips;
  readonly balance: Chips;
  /** When this player may claim again. */
  readonly nextClaimAt: number;
}

/** Thrown when a player claims again before their cooldown has elapsed. */
export class FaucetCooldownError extends Error {
  constructor(readonly nextClaimAt: number) {
    super(`Faucet is on cooldown until ${new Date(nextClaimAt).toISOString()}`);
    this.name = "FaucetCooldownError";
  }
}

/**
 * Hands out free play chips on a cooldown.
 *
 * This is what replaces a cashier. Players top up by waiting, not by paying, so
 * there is no payment processor to integrate and nothing to refund.
 */
export class Faucet {
  readonly #ledger: Ledger;
  readonly #amount: Chips;
  readonly #cooldownMs: number;
  readonly #clock: () => number;
  readonly #lastClaim = new Map<string, number>();

  constructor(ledger: Ledger, options: FaucetOptions) {
    this.#ledger = ledger;
    this.#amount = options.amount;
    this.#cooldownMs = options.cooldownMs;
    this.#clock = options.clock ?? Date.now;
  }

  /** When this player may next claim, or 0 if they may claim now. */
  nextClaimAt(userId: string): number {
    const last = this.#lastClaim.get(userId);
    if (last === undefined) return 0;
    const next = last + this.#cooldownMs;
    return next > this.#clock() ? next : 0;
  }

  /** Grants this player their chips, or throws if they are still on cooldown. */
  claim(userId: string): ClaimResult {
    const blockedUntil = this.nextClaimAt(userId);
    if (blockedUntil !== 0) throw new FaucetCooldownError(blockedUntil);

    const account = playerAccount(userId);
    // The mint is the one account allowed to go negative: that is how chips are
    // issued while keeping the books at zero.
    this.#ledger.post(MINT, account, this.#amount, "faucet", true);
    const now = this.#clock();
    this.#lastClaim.set(userId, now);

    return {
      granted: this.#amount,
      balance: this.#ledger.balanceOf(account),
      nextClaimAt: now + this.#cooldownMs,
    };
  }
}
