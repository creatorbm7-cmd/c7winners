import { HOUSE, MINT, playerAccount } from "./accounts.js";
import { Faucet, type ClaimResult } from "./faucet.js";
import { CAPABILITIES } from "./guards.js";
import { Ledger } from "./ledger.js";
import {
  COIN_FLIP,
  commitment,
  generateServerSeed,
  roll,
  settle,
  type GameRules,
  type RoundOutcome,
} from "./game.js";
import { assertChips, InsufficientChipsError, type Chips } from "./types.js";

export interface CasinoOptions {
  /** Chips handed out per faucet claim. Defaults to 1000. */
  readonly faucetAmount?: Chips;
  /** Faucet cooldown in milliseconds. Defaults to 24 hours. */
  readonly faucetCooldownMs?: number;
  readonly rules?: GameRules;
  readonly clock?: () => number;
  /** Server seed for provably fair rolls. Generated if not supplied. */
  readonly serverSeed?: string;
}

export interface BetResult extends RoundOutcome {
  readonly stake: Chips;
  readonly nonce: number;
  readonly balance: Chips;
  /** Net change to the player's balance: `payout - stake`. */
  readonly net: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A play-money casino.
 *
 * Chips come from a faucet, are wagered against the house, and go nowhere else.
 * There is no deposit path and no withdrawal path — not disabled ones, absent
 * ones. See `guards.ts` for the entry points that say so explicitly.
 */
export class PlayCasino {
  readonly #ledger: Ledger;
  readonly #faucet: Faucet;
  readonly #rules: GameRules;
  readonly #serverSeed: string;
  readonly #nonces = new Map<string, number>();

  constructor(options: CasinoOptions = {}) {
    const clock = options.clock ?? Date.now;
    this.#ledger = new Ledger(clock);
    this.#rules = options.rules ?? COIN_FLIP;
    this.#serverSeed = options.serverSeed ?? generateServerSeed();
    this.#faucet = new Faucet(this.#ledger, {
      amount: options.faucetAmount ?? 1000,
      cooldownMs: options.faucetCooldownMs ?? DAY_MS,
      clock,
    });
  }

  /** What this build supports. Reported from code, not configuration. */
  get capabilities(): typeof CAPABILITIES {
    return CAPABILITIES;
  }

  /** The public commitment to this session's server seed. Publish before play. */
  get seedCommitment(): string {
    return commitment(this.#serverSeed);
  }

  /**
   * Reveals the server seed so players can verify past rolls.
   *
   * Only call this when ending a session — once revealed, subsequent rolls with
   * this seed are predictable, so a new casino instance should be started.
   */
  revealServerSeed(): string {
    return this.#serverSeed;
  }

  /** A player's chip balance. */
  balanceOf(userId: string): Chips {
    return this.#ledger.balanceOf(playerAccount(userId));
  }

  /** Claims this player's free chips, or throws if they are on cooldown. */
  claimFaucet(userId: string): ClaimResult {
    return this.#faucet.claim(userId);
  }

  /** The house's net position: positive means the house is up. */
  houseBalance(): Chips {
    return this.#ledger.balanceOf(HOUSE);
  }

  /** Chips issued by the faucet and still in circulation. */
  chipsInCirculation(): Chips {
    return this.#ledger.inCirculation(MINT);
  }

  /**
   * Places one bet.
   *
   * The nonce increments per player so every roll is distinct and verifiable in
   * order. Both legs go through the ledger, so a bet can never create or destroy
   * chips — it only moves them.
   */
  bet(userId: string, stake: Chips, clientSeed: string): BetResult {
    assertChips(stake);
    const account = playerAccount(userId);
    const balance = this.#ledger.balanceOf(account);
    if (balance < stake) {
      throw new InsufficientChipsError(account, balance, stake);
    }

    const nonce = this.#nonces.get(userId) ?? 0;
    this.#nonces.set(userId, nonce + 1);

    this.#ledger.post(account, HOUSE, stake, "bet");
    const outcome = settle(roll(this.#serverSeed, clientSeed, nonce), stake, this.#rules);
    if (outcome.payout > 0) {
      // The house may go negative; its balance is simply its running P&L.
      this.#ledger.post(HOUSE, account, outcome.payout, "payout", true);
    }

    return {
      ...outcome,
      stake,
      nonce,
      balance: this.#ledger.balanceOf(account),
      net: outcome.payout - stake,
    };
  }

  /** Recomputes the books and throws if anything fails to reconcile. */
  assertHealthy(): void {
    this.#ledger.assertBalanced();
  }

  /** The full entry log, for auditing. */
  auditLog(): readonly import("./ledger.js").Entry[] {
    return this.#ledger.entries;
  }
}
