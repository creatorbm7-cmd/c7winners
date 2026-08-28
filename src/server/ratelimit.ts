/**
 * Token-bucket rate limiting.
 *
 * A bucket holds up to `capacity` tokens and refills steadily. Each request
 * takes one; an empty bucket is a refusal. This allows a short burst — a player
 * clicking quickly, a page loading several endpoints at once — while still
 * capping the sustained rate, which a fixed window does not: two full windows'
 * worth of requests can land back-to-back across a window boundary.
 */

export interface BucketConfig {
  /** Most requests allowed in a burst. */
  readonly capacity: number;
  /** How long the bucket takes to refill from empty, in milliseconds. */
  readonly refillMs: number;
}

export interface Decision {
  readonly allowed: boolean;
  /** Milliseconds until one token is available. 0 when allowed. */
  readonly retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Buckets are dropped once full, so idle keys cost nothing to keep. */
const SWEEP_THRESHOLD = 10_000;

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #config: BucketConfig;
  readonly #clock: () => number;
  readonly #refillPerMs: number;

  constructor(config: BucketConfig, clock: () => number = Date.now) {
    if (config.capacity <= 0 || config.refillMs <= 0) {
      throw new Error("Rate limit needs a positive capacity and refill window");
    }
    this.#config = config;
    this.#clock = clock;
    this.#refillPerMs = config.capacity / config.refillMs;
  }

  #bucketFor(key: string): Bucket {
    const now = this.#clock();
    const existing = this.#buckets.get(key);
    if (!existing) {
      const fresh = { tokens: this.#config.capacity, updatedAt: now };
      this.#buckets.set(key, fresh);
      return fresh;
    }
    const elapsed = now - existing.updatedAt;
    if (elapsed > 0) {
      existing.tokens = Math.min(
        this.#config.capacity,
        existing.tokens + elapsed * this.#refillPerMs,
      );
      existing.updatedAt = now;
    }
    return existing;
  }

  /** Takes one token, or refuses and says how long to wait. */
  take(key: string): Decision {
    this.#sweepIfCrowded();
    const bucket = this.#bucketFor(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      retryAfterMs: Math.ceil((1 - bucket.tokens) / this.#refillPerMs),
    };
  }

  /**
   * Returns a token taken earlier.
   *
   * Used so a successful sign-in does not count against the limit: the point is
   * to slow down guessing, not to lock out someone who typed their password
   * correctly the first time.
   */
  refund(key: string): void {
    const bucket = this.#buckets.get(key);
    if (bucket) bucket.tokens = Math.min(this.#config.capacity, bucket.tokens + 1);
  }

  /** How many whole requests this key has left right now. */
  remaining(key: string): number {
    return Math.floor(this.#bucketFor(key).tokens);
  }

  /**
   * Drops buckets that have refilled completely.
   *
   * Without this a stream of unique keys — one per spoofed address — would grow
   * the map without bound, turning the rate limiter into the thing it defends
   * against. A full bucket carries no information, so forgetting it is free.
   */
  #sweepIfCrowded(): void {
    if (this.#buckets.size < SWEEP_THRESHOLD) return;
    const now = this.#clock();
    for (const [key, bucket] of this.#buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs;
      if (refilled >= this.#config.capacity) this.#buckets.delete(key);
    }
  }

  /** Number of buckets currently held. Exposed for tests and health checks. */
  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * The client's address, honouring `X-Forwarded-For` only as far as it is trusted.
 *
 * `trustedProxies` is how many hops in front of this server are yours. Anyone can
 * put whatever they like in `X-Forwarded-For`, so the trustworthy entries are the
 * ones your own proxies appended — the rightmost. Taking the leftmost, or trusting
 * the header whenever it is present, lets a client pick a fresh identity per
 * request and walk straight through every limit here.
 */
export function clientAddress(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  trustedProxies: number,
): string {
  const direct = socketAddress ?? "unknown";
  if (trustedProxies <= 0) return direct;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!header) return direct;

  const hops = header.split(",").map((h) => h.trim()).filter(Boolean);
  // The last entry was added by the proxy nearest us; step back one hop per
  // trusted proxy. Fall back to the direct peer if the chain is shorter than
  // claimed, rather than believing a client-supplied entry.
  const index = hops.length - trustedProxies;
  return index >= 0 && index < hops.length ? (hops[index] ?? direct) : direct;
}
