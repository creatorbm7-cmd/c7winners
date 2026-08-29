import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COIN_FLIP,
  commitment,
  generateServerSeed,
  payoutMultiplier,
  roll,
  settle,
  verifyCommitment,
} from "./game.js";

describe("provably fair rolls", () => {
  it("produces the same roll for the same inputs", async () => {
    const seed = "a".repeat(64);
    assert.equal(await roll(seed, "client", 0), await roll(seed, "client", 0));
    assert.notEqual(await roll(seed, "client", 0), await roll(seed, "client", 1));
    assert.notEqual(await roll(seed, "client", 0), await roll(seed, "other", 0));
  });

  it("stays within [0, 1)", async () => {
    const seed = generateServerSeed();
    for (let n = 0; n < 500; n++) {
      const value = await roll(seed, "client", n);
      assert.ok(value >= 0 && value < 1, `roll ${n} was ${value}`);
    }
  });

  it("is roughly uniform", async () => {
    const seed = generateServerSeed();
    const buckets = new Array(10).fill(0) as number[];
    const trials = 20_000;
    for (let n = 0; n < trials; n++) {
      buckets[Math.floor((await roll(seed, "c", n)) * 10)]! += 1;
    }
    const expected = trials / 10;
    for (const [i, count] of buckets.entries()) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.15,
        `bucket ${i} held ${count}, expected about ${expected}`,
      );
    }
  });

  it("rejects a nonce that is not a non-negative integer", async () => {
    const seed = generateServerSeed();
    for (const bad of [-1, 1.5, Number.NaN]) {
      await assert.rejects(() => roll(seed, "c", bad), /Nonce/);
    }
  });

  it("verifies a revealed seed against its commitment", async () => {
    const seed = generateServerSeed();
    const published = await commitment(seed);
    assert.ok(await verifyCommitment(seed, published));
    assert.ok(!(await verifyCommitment(generateServerSeed(), published)));
    assert.ok(!(await verifyCommitment(seed, "deadbeef")));
    assert.ok(!(await verifyCommitment(seed, "not hex at all")));
  });
});

describe("settlement", () => {
  it("derives the multiplier from the stated house edge", () => {
    assert.equal(payoutMultiplier({ winChance: 0.5, houseEdge: 0.02 }), 1.96);
    assert.equal(payoutMultiplier({ winChance: 0.25, houseEdge: 0 }), 4);
  });

  it("pays out only on a win", () => {
    assert.deepEqual(settle(0.1, 100, COIN_FLIP), { roll: 0.1, won: true, payout: 196 });
    assert.deepEqual(settle(0.9, 100, COIN_FLIP), { roll: 0.9, won: false, payout: 0 });
  });

  it("never pays a fraction of a chip", () => {
    const { payout } = settle(0.1, 3, COIN_FLIP);
    assert.ok(Number.isInteger(payout));
    assert.equal(payout, 5); // floor(3 * 1.96)
  });

  it("realises exactly the stated edge over a uniform sweep of rolls", () => {
    // Deliberately not a Monte Carlo run. Sampling random rolls estimates the
    // edge with a standard error of mult*sqrt(p(1-p)/n) — at 40,000 rounds that
    // is 0.0049, so a +/-0.01 assertion sits just 2 standard errors out and
    // fails around 4% of the time. That is a coin flip the suite should not be
    // taking.
    //
    // Whether rolls are uniform is already checked above. What is left is
    // whether settle() applies the multiplier correctly, and that is exact: feed
    // it evenly spaced rolls and the realised edge must equal the stated one.
    const rounds = 1000;
    const stake = 10_000; // large enough that flooring the payout costs nothing
    let staked = 0;
    let returned = 0;
    for (let i = 0; i < rounds; i++) {
      const rollValue = (i + 0.5) / rounds; // 0.0005, 0.0015, ... 0.9995
      staked += stake;
      returned += settle(rollValue, stake, COIN_FLIP).payout;
    }
    assert.equal((staked - returned) / staked, COIN_FLIP.houseEdge);
  });

  it("realises the stated edge for other rules too", () => {
    const rules = { winChance: 0.25, houseEdge: 0.05 };
    const rounds = 1000;
    const stake = 10_000;
    let staked = 0;
    let returned = 0;
    for (let i = 0; i < rounds; i++) {
      staked += stake;
      returned += settle((i + 0.5) / rounds, stake, rules).payout;
    }
    assert.equal((staked - returned) / staked, rules.houseEdge);
  });
});
