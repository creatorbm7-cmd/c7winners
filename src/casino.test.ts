import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlayCasino } from "./casino.js";
import { FaucetCooldownError } from "./faucet.js";
import { verifyCommitment } from "./game.js";
import { InsufficientChipsError } from "./types.js";

/** A clock the test drives by hand. */
function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("PlayCasino", () => {
  it("starts a player with nothing until they claim", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.equal(casino.balanceOf("alice"), 0);
    assert.throws(() => casino.bet("alice", 10, "seed"), InsufficientChipsError);
  });

  it("grants faucet chips and holds a cooldown", () => {
    const clock = fakeClock();
    const casino = new PlayCasino({
      clock: clock.now,
      faucetAmount: 500,
      faucetCooldownMs: 1000,
    });

    assert.equal(casino.claimFaucet("alice").granted, 500);
    assert.equal(casino.balanceOf("alice"), 500);
    assert.throws(() => casino.claimFaucet("alice"), FaucetCooldownError);

    clock.advance(1000);
    assert.equal(casino.claimFaucet("alice").granted, 500);
    assert.equal(casino.balanceOf("alice"), 1000);
    casino.assertHealthy();
  });

  it("holds cooldowns per player", () => {
    const casino = new PlayCasino({ clock: () => 0, faucetCooldownMs: 1000 });
    casino.claimFaucet("alice");
    assert.doesNotThrow(() => casino.claimFaucet("bob"));
    assert.throws(() => casino.claimFaucet("alice"), FaucetCooldownError);
  });

  it("moves chips on a bet without creating or destroying any", () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 1000, serverSeed: "s".repeat(64) });
    casino.claimFaucet("alice");

    const before = casino.balanceOf("alice") + casino.houseBalance();
    const result = casino.bet("alice", 100, "client");
    const after = casino.balanceOf("alice") + casino.houseBalance();

    assert.equal(before, after, "a bet changed the total number of chips");
    assert.equal(result.net, result.payout - result.stake);
    assert.equal(casino.balanceOf("alice"), 1000 - 100 + result.payout);
    casino.assertHealthy();
  });

  it("refuses a stake larger than the balance", () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 50 });
    casino.claimFaucet("alice");
    assert.throws(() => casino.bet("alice", 51, "client"), InsufficientChipsError);
    assert.equal(casino.balanceOf("alice"), 50);
    casino.assertHealthy();
  });

  it("advances the nonce so each roll is distinct", () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 10_000 });
    casino.claimFaucet("alice");
    const nonces = [0, 1, 2].map(() => casino.bet("alice", 10, "client").nonce);
    assert.deepEqual(nonces, [0, 1, 2]);
  });

  it("publishes a commitment that its revealed seed satisfies", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.ok(verifyCommitment(casino.revealServerSeed(), casino.seedCommitment));
  });

  it("keeps the books reconciled across a long session", () => {
    const clock = fakeClock();
    const casino = new PlayCasino({
      clock: clock.now,
      faucetAmount: 5000,
      faucetCooldownMs: 100,
    });

    for (const user of ["alice", "bob", "carol"]) casino.claimFaucet(user);
    for (let i = 0; i < 1500; i++) {
      const user = ["alice", "bob", "carol"][i % 3]!;
      const balance = casino.balanceOf(user);
      if (balance < 10) {
        clock.advance(100);
        try {
          casino.claimFaucet(user);
        } catch {
          continue;
        }
        continue;
      }
      casino.bet(user, Math.min(balance, (i % 50) + 1), `seed-${user}`);
    }

    casino.assertHealthy();
    for (const user of ["alice", "bob", "carol"]) {
      assert.ok(casino.balanceOf(user) >= 0, `${user} went negative`);
    }
    // Chips only ever come from the faucet, so circulation equals what it issued.
    const issued = casino
      .auditLog()
      .filter((e) => e.reason === "faucet")
      .reduce((sum, e) => sum + e.amount, 0);
    assert.equal(casino.chipsInCirculation(), issued);
  });

  it("records every movement in the audit log", () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 100 });
    casino.claimFaucet("alice");
    casino.bet("alice", 10, "client");
    const reasons = casino.auditLog().map((e) => e.reason);
    assert.equal(reasons[0], "faucet");
    assert.ok(reasons.includes("bet"));
  });

  it("reports itself as play-money only", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.equal(casino.capabilities.mode, "play-money");
    assert.equal(casino.capabilities.deposits, false);
    assert.equal(casino.capabilities.withdrawals, false);
  });
});
