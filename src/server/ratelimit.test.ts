import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter, clientAddress } from "./ratelimit.js";

function clocked(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 3, refillMs: 1000 }, c.now);
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.take("a").allowed, true, `request ${i + 1} was refused`);
    }
    const refused = limiter.take("a");
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterMs > 0, "no retry hint given");
  });

  it("refills steadily rather than all at once", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 3, refillMs: 3000 }, c.now);
    for (let i = 0; i < 3; i++) limiter.take("a");
    assert.equal(limiter.take("a").allowed, false);

    c.advance(1000); // one token's worth
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false, "refilled more than it should have");

    c.advance(3000); // fully refilled, and no further
    assert.equal(limiter.remaining("a"), 3);
  });

  it("keeps keys independent", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 1, refillMs: 1000 }, c.now);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
    assert.equal(limiter.take("b").allowed, true, "b was punished for a's usage");
  });

  it("reports how long to wait, and the wait is enough", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 2, refillMs: 2000 }, c.now);
    limiter.take("a");
    limiter.take("a");
    const { retryAfterMs } = limiter.take("a");
    c.advance(retryAfterMs);
    assert.equal(limiter.take("a").allowed, true, "the advertised wait was too short");
  });

  it("gives a token back on refund but never exceeds capacity", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 2, refillMs: 1000 }, c.now);
    limiter.take("a");
    limiter.refund("a");
    assert.equal(limiter.remaining("a"), 2);
    limiter.refund("a");
    limiter.refund("a");
    assert.equal(limiter.remaining("a"), 2, "refund overfilled the bucket");
  });

  it("rejects a nonsensical configuration", () => {
    assert.throws(() => new RateLimiter({ capacity: 0, refillMs: 1000 }));
    assert.throws(() => new RateLimiter({ capacity: 1, refillMs: 0 }));
  });

  it("forgets refilled buckets so unique keys cannot grow it without bound", () => {
    const c = clocked();
    const limiter = new RateLimiter({ capacity: 1, refillMs: 1000 }, c.now);
    for (let i = 0; i < 10_050; i++) limiter.take(`key-${i}`);
    const beforeSweep = limiter.size;
    c.advance(5000); // everything has refilled
    limiter.take("trigger-a-sweep");
    assert.ok(limiter.size < beforeSweep, `map did not shrink: ${beforeSweep} -> ${limiter.size}`);
  });
});

describe("clientAddress", () => {
  it("ignores the forwarded header when no proxy is trusted", () => {
    assert.equal(clientAddress("1.2.3.4", "10.0.0.1", 0), "10.0.0.1");
    assert.equal(clientAddress("1.2.3.4, 5.6.7.8", "10.0.0.1", 0), "10.0.0.1");
  });

  it("takes the hop its own proxy appended, not the client's claim", () => {
    // A client sent "9.9.9.9"; our single proxy appended the real peer.
    assert.equal(clientAddress("9.9.9.9, 203.0.113.7", "10.0.0.1", 1), "203.0.113.7");
  });

  it("steps back one hop per trusted proxy", () => {
    assert.equal(clientAddress("9.9.9.9, 203.0.113.7, 10.0.0.9", "10.0.0.1", 2), "203.0.113.7");
  });

  it("falls back to the peer when the chain is shorter than claimed", () => {
    assert.equal(clientAddress("203.0.113.7", "10.0.0.1", 3), "10.0.0.1");
    assert.equal(clientAddress(undefined, "10.0.0.1", 1), "10.0.0.1");
    assert.equal(clientAddress("", "10.0.0.1", 1), "10.0.0.1");
  });

  it("handles a repeated header and an unknown peer", () => {
    assert.equal(clientAddress(["9.9.9.9", "203.0.113.7"], "10.0.0.1", 1), "203.0.113.7");
    assert.equal(clientAddress(undefined, undefined, 0), "unknown");
  });

  it("cannot be walked around by spoofing many addresses", () => {
    // With no trusted proxy, every spoofed header still resolves to one peer,
    // so a single client cannot mint a fresh rate-limit identity per request.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(clientAddress(`1.2.3.${i}`, "10.0.0.1", 0));
    assert.deepEqual([...seen], ["10.0.0.1"]);
  });
});
