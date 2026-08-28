import type { Db } from "./db.js";
import { PostgresDb } from "./db-postgres.js";
import { SqliteDb } from "./db-sqlite.js";

export interface DatabaseChoice {
  readonly db: Db;
  readonly dialect: "sqlite" | "postgres";
}

/**
 * Picks the engine from the environment.
 *
 * `DATABASE_URL` means Postgres, which is what any deployment with more than one
 * process needs. Without it, SQLite — fine for a single process and for tests,
 * but it keeps its data on local disk, so a platform that resets the filesystem
 * between requests would silently lose every account.
 */
export function createDatabase(options: {
  connectionString?: string | undefined;
  sqlitePath?: string;
}): DatabaseChoice {
  const url = options.connectionString?.trim();
  if (url) return { db: new PostgresDb(url), dialect: "postgres" };
  return { db: new SqliteDb(options.sqlitePath ?? "c7winners.db"), dialect: "sqlite" };
}
