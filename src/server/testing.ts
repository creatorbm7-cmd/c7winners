import type { Db } from "./db.js";
import { PostgresDb } from "./db-postgres.js";
import { SqliteDb } from "./db-sqlite.js";

export interface TestEngine {
  readonly name: string;
  readonly dialect: "sqlite" | "postgres";
  /** A fresh, empty database. */
  open(): Promise<Db>;
}

/**
 * The engines the suite runs against.
 *
 * SQLite is always included. Postgres joins when TEST_DATABASE_URL is set — CI
 * provides one, and so does a local cluster — each test getting its own schema
 * so runs cannot see each other's rows.
 */
export async function testDatabases(): Promise<TestEngine[]> {
  const engines: TestEngine[] = [
    { name: "sqlite", dialect: "sqlite", open: async () => new SqliteDb(":memory:") },
  ];

  const url = process.env["TEST_DATABASE_URL"]?.trim();
  if (url) {
    let counter = 0;
    engines.push({
      name: "postgres",
      dialect: "postgres",
      open: async () => {
        const schema = `t${process.pid}_${Date.now().toString(36)}_${counter++}`;
        // Create the schema on a throwaway connection, then open a pool pinned
        // to it. Setting search_path with a statement would only bind the one
        // connection that ran it.
        const setup = new PostgresDb(url);
        await setup.run(`CREATE SCHEMA ${schema}`);
        await setup.close();
        return new PostgresDb(url, { schema });
      },
    });
  }
  return engines;
}
