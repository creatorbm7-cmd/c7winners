import pg from "pg";
import { toNumberedPlaceholders, type Db, type Row } from "./db.js";

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Postgres adapter.
 *
 * A transaction has to run every statement on one connection, so the pool is
 * bypassed for its duration by checking a client out and using it directly —
 * issuing BEGIN on the pool and the statements on whatever connection came next
 * would silently split the transaction across connections.
 */
export class PostgresDb implements Db {
  readonly #pool: pg.Pool;
  #tx: pg.PoolClient | null = null;

  constructor(connectionString: string, options: { max?: number; schema?: string } = {}) {
    // search_path has to be a connection option, not a statement. `SET` applies
    // to one connection, and the next query out of the pool may well be on a
    // different one — the schema would then be silently missing.
    if (options.schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.schema)) {
      throw new Error(`Unsafe schema name: ${options.schema}`);
    }
    this.#pool = new pg.Pool({
      connectionString,
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
      // Serverless invocations are short-lived and many, so each instance keeps
      // a small pool and lets the connection pooler in front do the sharing.
      max: options.max ?? 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ...(connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
    });
  }

  async #query(sql: string, params: readonly unknown[]): Promise<Row[]> {
    const text = toNumberedPlaceholders(sql);
    const runner = this.#tx ?? this.#pool;
    const result = await runner.query(text, params as unknown[]);
    return result.rows as Row[];
  }

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.#query(sql, params);
  }

  async get(sql: string, params: readonly unknown[] = []): Promise<Row | undefined> {
    return (await this.#query(sql, params))[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.#query(sql, params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx) throw new Error("Nested transactions are not supported");
    const client = await this.#pool.connect();
    this.#tx = client;
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already unusable; releasing it is all that is left.
      }
      throw err;
    } finally {
      this.#tx = null;
      client.release();
    }
  }

  isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
