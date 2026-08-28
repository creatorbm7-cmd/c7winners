import type { AccountId } from "./types.js";

/**
 * Where play chips come from.
 *
 * Chips are minted here rather than appearing from nowhere, so every chip in
 * circulation has a matching ledger entry. This account's balance runs negative
 * by exactly the number of chips in circulation, which keeps the books at zero.
 */
export const MINT: AccountId = "system:mint";

/** The counterparty for every game round. Wins are paid from here; losses land here. */
export const HOUSE: AccountId = "system:house";

/** Every system account. Anything else in the ledger belongs to a player. */
export const SYSTEM_ACCOUNTS: readonly AccountId[] = [MINT, HOUSE];

/** The ledger account for a player. */
export function playerAccount(userId: string): AccountId {
  if (!userId || /[\s:]/.test(userId)) {
    throw new Error(`Invalid user id: ${JSON.stringify(userId)}`);
  }
  return `player:${userId}`;
}

/** True when the account belongs to a player rather than the system. */
export function isPlayerAccount(account: AccountId): boolean {
  return account.startsWith("player:");
}
