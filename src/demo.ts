/**
 * A short session against the play-money casino, printed to stdout.
 *
 * Run with `npm run demo`. Nothing here touches real money; the chips are minted
 * by the faucet and cannot leave the ledger.
 */
import { PlayCasino } from "./casino.js";
import { verifyCommitment } from "./game.js";

const casino = new PlayCasino({ faucetAmount: 1000, rules: { winChance: 0.5, houseEdge: 0.02 } });

console.log("mode:        ", casino.capabilities.mode);
console.log("currency:    ", casino.capabilities.currency, "(no cash value)");
console.log("deposits:    ", casino.capabilities.deposits);
console.log("withdrawals: ", casino.capabilities.withdrawals);
console.log("seed commitment:", casino.seedCommitment);
console.log();

const claim = casino.claimFaucet("alice");
console.log(`alice claimed ${claim.granted} chips -> balance ${claim.balance}`);
console.log();

for (let i = 0; i < 8; i++) {
  const result = casino.bet("alice", 100, "alice-seed");
  const verdict = result.won ? `won  +${result.net}` : `lost ${result.net}`;
  console.log(
    `bet ${String(i + 1).padStart(2)}  roll ${result.roll.toFixed(6)}  ${verdict.padEnd(10)}  balance ${result.balance}`,
  );
}

console.log();
console.log("chips in circulation:", casino.chipsInCirculation());
console.log("house position:      ", casino.houseBalance());
console.log("ledger entries:      ", casino.auditLog().length);

casino.assertHealthy();
console.log("books reconcile:      yes");

const seed = casino.revealServerSeed();
console.log("seed revealed:       ", seed.slice(0, 16) + "...");
console.log("commitment verifies: ", verifyCommitment(seed, casino.seedCommitment));
