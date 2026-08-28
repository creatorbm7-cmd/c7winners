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
  it("produces the same roll for the same inputs", () => {
    const seed = "a".repeat(64);
    assert.equal(roll(seed, "client", 0), roll(seed, "client", 0));
    assert.notEqual(roll(seed, "client", 0), roll(seed, "client", 1));
    assert.notEqual(roll(seed, "client", 0), roll(seed, "other", 0));
  });

  it("stays within [0, 1)", () => {
    const seed = generateServerSeed();
    for (let n = 0; n < 500; n++) {
      const value = roll(seed, "client", n);
      assert.ok(value >= 0 && value < 1, `roll ${n} was ${value}`);
    }
  });

  it("is roughly uniform", () => {
    const seed = generateServerSeed();
    const buckets = new Array(10).fill(0) as number[];
    const trials = 20_000;
    for (let n = 0; n < trials; n++) {
      buckets[Math.floor(roll(seed, "c", n) * 10)]! += 1;
    }
    const expected = trials / 10;
    for (const [i, count] of buckets.entries()) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.15,
        `bucket ${i} held ${count}, expected about ${expected}`,
      );
    }
  });

  it("rejects a nonce that is not a non-negative integer", () => {
    const seed = generateServerSeed();
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => roll(seed, "c", bad), /Nonce/);
    }
  });

  it("verifies a revealed seed against its commitment", () => {
    const seed = generateServerSeed();
    const published = commitment(seed);
    assert.ok(verifyCommitment(seed, published));
    assert.ok(!verifyCommitment(generateServerSeed(), published));
    assert.ok(!verifyCommitment(seed, "deadbeef"));
    assert.ok(!verifyCommitment(seed, "not hex at all"));
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

  it("gives the house its stated edge over many rounds", () => {
    const seed = generateServerSeed();
    const stake = 1000;
    let staked = 0;
    let returned = 0;
    for (let n = 0; n < 40_000; n++) {
      staked += stake;
      returned += settle(roll(seed, "c", n), stake, COIN_FLIP).payout;
    }
    const edge = (staked - returned) / staked;
    assert.ok(
      Math.abs(edge - COIN_FLIP.houseEdge) < 0.01,
      `house edge came out at ${edge}, expected about ${COIN_FLIP.houseEdge}`,
    );
  });
});
