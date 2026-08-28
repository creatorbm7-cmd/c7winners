import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Provably fair rolls, using the standard commit-reveal scheme.
 *
 * The server picks a secret seed and publishes only its hash before any betting.
 * Each roll mixes that secret with a seed the player chooses and a nonce that
 * increments per bet. When the session ends the server reveals the seed, and the
 * player can recompute every roll and check the hash matches what was published.
 *
 * The server cannot change the seed after the fact without breaking the hash, and
 * cannot steer an individual roll without knowing the player's seed in advance.
 */

/** A fresh server seed. Keep secret until the session is over, then reveal it. */
export function generateServerSeed(): string {
  return randomBytes(32).toString("hex");
}

/** The public commitment to a server seed, published before any bets are placed. */
export function commitment(serverSeed: string): string {
  return createHash("sha256").update(serverSeed).digest("hex");
}

/** Checks a revealed seed against the commitment published earlier. */
export function verifyCommitment(serverSeed: string, published: string): boolean {
  const actual = Buffer.from(commitment(serverSeed), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(published, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * The roll for one bet, in [0, 1).
 *
 * Deterministic: the same three inputs always produce the same roll, which is
 * exactly what lets a player verify the outcome afterwards.
 */
export function roll(serverSeed: string, clientSeed: string, nonce: number): number {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`Nonce must be a non-negative integer, got: ${nonce}`);
  }
  const digest = createHmac("sha256", serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest();
  // 48 bits, which a double holds exactly, giving a uniform [0, 1).
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

export interface GameRules {
  /** Chance of the player winning a round, in (0, 1). */
  readonly winChance: number;
  /** The house's long-run cut, in [0, 1). */
  readonly houseEdge: number;
}

/** A coin flip with a 2% house edge: even odds, slightly under 2x on a win. */
export const COIN_FLIP: GameRules = { winChance: 0.5, houseEdge: 0.02 };

/**
 * What a winning bet pays back, per chip staked.
 *
 * Derived from the rules rather than hardcoded, so the edge stated in `GameRules`
 * is the edge the game actually has.
 */
export function payoutMultiplier(rules: GameRules): number {
  return (1 - rules.houseEdge) / rules.winChance;
}

export interface RoundOutcome {
  readonly roll: number;
  readonly won: boolean;
  /** Chips returned to the player: the full return on a win, 0 on a loss. */
  readonly payout: number;
}

/** Settles one round against the rules. */
export function settle(rollValue: number, stake: number, rules: GameRules): RoundOutcome {
  const won = rollValue < rules.winChance;
  // Floor rather than round, so the house never pays out a fraction of a chip it
  // did not take. At a 1-chip stake this makes a win break even.
  const payout = won ? Math.floor(stake * payoutMultiplier(rules)) : 0;
  return { roll: rollValue, won, payout };
}
