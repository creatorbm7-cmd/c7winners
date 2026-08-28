/**
 * The only currency this platform knows how to handle.
 *
 * There is deliberately no real-money variant of this type. Adding one is not a
 * config change — it would require a gaming licence, an approved regulated
 * payment processor, and a reserve that fully backs user balances. Until those
 * exist, the type system itself is the interlock.
 */
export type Currency = "PLAY";

/** The single currency value. Play chips have no cash value and cannot be cashed out. */
export const CURRENCY: Currency = "PLAY";

/** An account in the ledger, e.g. `player:alice` or `system:house`. */
export type AccountId = string;

/**
 * Play chips, always a non-negative integer.
 *
 * Chips are integers so balances are exact. Money-like values held in floats
 * accumulate rounding error, and a ledger that does not reconcile exactly is a
 * ledger nobody can trust.
 */
export type Chips = number;

/** Thrown when an amount is not a positive whole number of chips. */
export class InvalidAmountError extends Error {
  constructor(amount: unknown) {
    super(`Amount must be a positive integer number of chips, got: ${String(amount)}`);
    this.name = "InvalidAmountError";
  }
}

/** Thrown when an account does not hold enough chips for an operation. */
export class InsufficientChipsError extends Error {
  constructor(
    readonly account: AccountId,
    readonly balance: Chips,
    readonly required: Chips,
  ) {
    super(`Account ${account} holds ${balance} chips, needs ${required}`);
    this.name = "InsufficientChipsError";
  }
}

/** Validates that a value is a positive integer count of chips. */
export function assertChips(amount: unknown): asserts amount is Chips {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidAmountError(amount);
  }
}
