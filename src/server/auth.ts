import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password and session handling.
 *
 * scrypt rather than a plain hash: passwords are low-entropy, so the cost of
 * checking one has to be high enough that guessing them in bulk is not worth it.
 */

const SCRYPT_KEYLEN = 64;
/** Deliberately expensive. Raising this is a schema-compatible change. */
const SCRYPT_COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface PasswordRecord {
  readonly hash: string;
  readonly salt: string;
}

/** Hashes a password with a fresh random salt. */
export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString("hex");
  return { hash, salt };
}

/** Checks a password against a stored record, in constant time. */
export function verifyPassword(password: string, record: PasswordRecord): boolean {
  let candidate: Buffer;
  try {
    candidate = scryptSync(password, record.salt, SCRYPT_KEYLEN, SCRYPT_COST);
  } catch {
    return false;
  }
  let stored: Buffer;
  try {
    stored = Buffer.from(record.hash, "hex");
  } catch {
    return false;
  }
  if (stored.length !== candidate.length) return false;
  return timingSafeEqual(stored, candidate);
}

/** A new opaque session token. Given to the client once and never stored as-is. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * What gets stored for a session token.
 *
 * Tokens are stored hashed for the same reason passwords are: a leaked database
 * should not hand over working credentials. A fast hash is right here — tokens
 * are already high-entropy, so there is nothing to brute-force.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** Why a credential was rejected, or null when it is acceptable. */
export function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    return "Username must be 3-24 characters, letters, numbers, hyphen or underscore.";
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
