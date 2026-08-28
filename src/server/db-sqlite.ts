import { DatabaseSync } from "node:sqlite";
import type { Db, Row } from "./db.js";

/**
 * SQLite adapter, used for tests and single-process local runs.
 *
 * `node:sqlite` is synchronous; the promises here are already-resolved, which is
 * what lets the store present one async interface over both engines.
 */
export class SqliteDb implements Db {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
  }

  /** Runs raw DDL. Only migrations should need this. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  async all(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    return this.#db.prepare(sql).all(...(params as never[])) as Row[];
  }

  async get(sql: string, params: readonly unknown[] = []): Promise<Row | undefined> {
    return this.#db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.#db.prepare(sql).run(...(params as never[]));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // IMMEDIATE takes the write lock up front, so a transaction cannot start
    // reading, then fail to upgrade when it tries to write.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  isUniqueViolation(err: unknown): boolean {
    return /UNIQUE constraint failed/i.test(String(err));
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
