import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlayCasino } from "./casino.js";
import { LedgerCorruptError } from "./ledger.js";
import { FaucetCooldownError } from "./faucet.js";
import { verifyCommitment } from "./game.js";
import { InsufficientChipsError } from "./types.js";

/** A clock the test drives by hand. */
function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("PlayCasino", () => {
  it("starts a player with nothing until they claim", async () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.equal(casino.balanceOf("alice"), 0);
    await assert.rejects(() => casino.bet("alice", 10, "seed"), InsufficientChipsError);
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

  it("moves chips on a bet without creating or destroying any", async () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 1000, serverSeed: "s".repeat(64) });
    casino.claimFaucet("alice");

    const before = casino.balanceOf("alice") + casino.houseBalance();
    const result = await casino.bet("alice", 100, "client");
    const after = casino.balanceOf("alice") + casino.houseBalance();

    assert.equal(before, after, "a bet changed the total number of chips");
    assert.equal(result.net, result.payout - result.stake);
    assert.equal(casino.balanceOf("alice"), 1000 - 100 + result.payout);
    casino.assertHealthy();
  });

  it("refuses a stake larger than the balance", async () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 50 });
    casino.claimFaucet("alice");
    await assert.rejects(() => casino.bet("alice", 51, "client"), InsufficientChipsError);
    assert.equal(casino.balanceOf("alice"), 50);
    casino.assertHealthy();
  });

  it("advances the nonce so each roll is distinct", async () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 10_000 });
    casino.claimFaucet("alice");
    const nonces: number[] = [];
    for (let i = 0; i < 3; i++) nonces.push((await casino.bet("alice", 10, "client")).nonce);
    assert.deepEqual(nonces, [0, 1, 2]);
  });

  it("publishes a commitment that its revealed seed satisfies", async () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.ok(await verifyCommitment(casino.revealServerSeed(), await casino.seedCommitment()));
  });

  it("keeps the books reconciled across a long session", async () => {
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
      await casino.bet(user, Math.min(balance, (i % 50) + 1), `seed-${user}`);
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

  it("records every movement in the audit log", async () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 100 });
    casino.claimFaucet("alice");
    await casino.bet("alice", 10, "client");
    const reasons = casino.auditLog().map((e) => e.reason);
    assert.equal(reasons[0], "faucet");
    assert.ok(reasons.includes("bet"));
  });

  it("round-trips through a snapshot", async () => {
    const clock = fakeClock();
    const a = new PlayCasino({ clock: clock.now, faucetAmount: 1000, faucetCooldownMs: 5000 });
    a.claimFaucet("alice");
    for (let i = 0; i < 5; i++) await a.bet("alice", 50, "seed");

    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    const b = new PlayCasino({ clock: clock.now, faucetAmount: 1000, faucetCooldownMs: 5000 });
    b.restore(snap);

    assert.equal(b.balanceOf("alice"), a.balanceOf("alice"));
    assert.equal(b.houseBalance(), a.houseBalance());
    assert.equal(b.auditLog().length, a.auditLog().length);
    assert.equal(await b.seedCommitment(), await a.seedCommitment());
    // the cooldown survived, so a restore cannot be used to re-claim
    assert.throws(() => b.claimFaucet("alice"), FaucetCooldownError);
    // the nonce survived, so the next roll is not a repeat
    assert.equal((await b.bet("alice", 10, "seed")).nonce, 5);
    b.assertHealthy();
  });

  it("refuses a restore that would hand a player chips from nowhere", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.throws(() => casino.restore({
      // alice pays the house without ever having been issued anything
      entries: [{ seq: 1, at: 0, from: "player:alice", to: "system:house", amount: 500, reason: "bet" }],
      nonces: {}, lastClaims: {}, serverSeed: "x".repeat(64),
    }), /would hold -500 chips/);
  });

  it("rejects a stored entry that moves chips to itself", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.throws(() => casino.restore({
      entries: [{ seq: 1, at: 0, from: "player:alice", to: "player:alice", amount: 500, reason: "faucet" }],
      nonces: {}, lastClaims: {}, serverSeed: "x".repeat(64),
    }), LedgerCorruptError);
  });

  it("leaves the casino untouched when a restore is rejected", async () => {
    const casino = new PlayCasino({ clock: () => 0, faucetAmount: 1000 });
    casino.claimFaucet("alice");
    await casino.bet("alice", 100, "seed");
    const entriesBefore = casino.auditLog().length;
    const aliceBefore = casino.balanceOf("alice");
    const houseBefore = casino.houseBalance();

    assert.throws(() => casino.restore({
      entries: [{ seq: 1, at: 0, from: "player:mallory", to: "system:house", amount: 9999, reason: "bet" }],
      nonces: {}, lastClaims: {}, serverSeed: "x".repeat(64),
    }), /would hold/);

    // the rejected snapshot must not have been half-applied
    assert.equal(casino.balanceOf("mallory"), 0, "mallory leaked into the books");
    assert.equal(casino.auditLog().length, entriesBefore, "the log was overwritten");
    assert.equal(casino.balanceOf("alice"), aliceBefore, "alice's balance changed");
    assert.equal(casino.houseBalance(), houseBefore, "the house position changed");
    casino.assertHealthy();
  });

  it("reports itself as play-money only", () => {
    const casino = new PlayCasino({ clock: () => 0 });
    assert.equal(casino.capabilities.mode, "play-money");
    assert.equal(casino.capabilities.deposits, false);
    assert.equal(casino.capabilities.withdrawals, false);
  });
});
