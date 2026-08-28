/**
 * A minimal database interface, so the store has one implementation rather than
 * one per engine.
 *
 * Queries are written once with `?` placeholders; the Postgres adapter rewrites
 * them to `$1, $2, …`. Everything else the store needs — RETURNING, `lower()`
 * comparisons, transactions — is spelled the same way on both engines, so there
 * is no second dialect to keep in step.
 */

export type Row = Record<string, unknown>;

export interface Db {
  all(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  get(sql: string, params?: readonly unknown[]): Promise<Row | undefined>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /** Runs `fn` in a transaction, rolling back if it throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** True when this error is a unique-constraint violation. */
  isUniqueViolation(err: unknown): boolean;
  close(): Promise<void>;
}

/** Rewrites `?` placeholders to Postgres `$n`, leaving `?` inside strings alone. */
export function toNumberedPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      // '' inside a string literal is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}
