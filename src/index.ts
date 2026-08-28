/**
 * c7winners — play-money game platform core.
 *
 * Play chips only. There is no real-money engine, no deposit path and no
 * withdrawal path in this build; `guards.ts` holds the entry points that say so.
 * Adding real money is not a configuration change — see `types.ts`.
 */
export { PlayCasino, type BetResult, type CasinoOptions } from "./casino.js";
export { Ledger, LedgerCorruptError, type Entry } from "./ledger.js";
export { Faucet, FaucetCooldownError, type ClaimResult } from "./faucet.js";
export {
  COIN_FLIP,
  commitment,
  generateServerSeed,
  payoutMultiplier,
  roll,
  settle,
  verifyCommitment,
  type GameRules,
  type RoundOutcome,
} from "./game.js";
export {
  CAPABILITIES,
  RealMoneyUnsupportedError,
  assertPlayMoney,
  cashOut,
  deposit,
  withdraw,
} from "./guards.js";
export { HOUSE, MINT, isPlayerAccount, playerAccount } from "./accounts.js";
export {
  CURRENCY,
  InsufficientChipsError,
  InvalidAmountError,
  assertChips,
  type AccountId,
  type Chips,
  type Currency,
} from "./types.js";
