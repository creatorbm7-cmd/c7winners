import { CURRENCY, type Currency } from "./types.js";

/**
 * Thrown by any entry point that would move real money.
 *
 * These functions exist so that "can this platform take a deposit?" has a single,
 * greppable, testable answer instead of being a property nobody can locate. They
 * are not a config flag that someone can flip in production — the real-money code
 * paths are absent, and these throw in their place.
 */
export class RealMoneyUnsupportedError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is not supported: this platform handles play chips only. ` +
        `Real-money operation requires a gaming licence, an approved regulated ` +
        `payment processor, and a reserve that fully backs user balances.`,
    );
    this.name = "RealMoneyUnsupportedError";
  }
}

/** Narrows a currency string, rejecting anything that is not play chips. */
export function assertPlayMoney(currency: string): asserts currency is Currency {
  if (currency !== CURRENCY) {
    throw new RealMoneyUnsupportedError(`Currency ${JSON.stringify(currency)}`);
  }
}

/** Real-money deposits. Always throws. */
export function deposit(): never {
  throw new RealMoneyUnsupportedError("Deposit");
}

/** Real-money withdrawals. Always throws. */
export function withdraw(): never {
  throw new RealMoneyUnsupportedError("Withdrawal");
}

/** Converting play chips to any other asset. Always throws. */
export function cashOut(): never {
  throw new RealMoneyUnsupportedError("Cash-out");
}

/**
 * What this build can and cannot do, for display in a status panel.
 *
 * Reported from the code rather than from configuration, so the panel cannot
 * show a capability the build does not actually have.
 */
export const CAPABILITIES = Object.freeze({
  mode: "play-money",
  currency: CURRENCY,
  realMoneyEngine: false,
  deposits: false,
  withdrawals: false,
  cashOut: false,
  requiresGamingLicence: false,
  requiresPaymentProcessor: false,
} as const);
