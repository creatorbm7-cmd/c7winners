import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  const path = options.sqlitePath ?? "c7winners.db";
  ensureDirectory(path);
  try {
    return { db: new SqliteDb(path), dialect: "sqlite" };
  } catch (err) {
    throw new Error(
      `Could not open the database at ${path}: ${(err as Error).message}. ` +
        `If that path is on a mounted volume, check the mount path and that ` +
        `this process can write to it (running as uid ${process.getuid?.() ?? "?"}).`,
    );
  }
}

/**
 * Makes the directory the database file will live in, if it is missing.
 *
 * SQLite will not create it, and a missing one is the ordinary case the first
 * time a volume is attached. Left alone the open throws SQLITE_CANTOPEN, the
 * process dies before it listens, and the platform keeps the previous container
 * serving — which from outside is indistinguishable from a deploy that never
 * ran. Failing here instead says which directory and why.
 */
function ensureDirectory(path: string): void {
  const directory = dirname(path);
  if (directory === "." || directory === "" || existsSync(directory)) return;
  try {
    mkdirSync(directory, { recursive: true });
  } catch (err) {
    throw new Error(
      `Could not create ${directory} for the database at ${path}: ${(err as Error).message}. ` +
        `Check the volume's mount path, and that this process can write there ` +
        `(running as uid ${process.getuid?.() ?? "?"}).`,
    );
  }
}
