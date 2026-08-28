import type { Db } from "./db.js";

/**
 * The schema, in the subset of SQL both engines accept.
 *
 * The ledger's defining property lives here rather than only in application
 * code: entries are append-only and a balance is a SUM over them, so there is no
 * stored balance that can drift. The CHECK constraints restate the rules the
 * store enforces, so a bug above cannot write a movement the domain forbids.
 *
 * There is deliberately no deposit, withdrawal or payout table. Real money is
 * absent from this schema, not switched off in it.
 */
const STATEMENTS = (idColumn: string) => [
  `CREATE TABLE IF NOT EXISTS users (
     id            ${idColumn},
     username      TEXT   NOT NULL,
     password_hash TEXT   NOT NULL,
     salt          TEXT   NOT NULL,
     created_at    BIGINT NOT NULL,
     server_seed   TEXT   NOT NULL,
     client_seed   TEXT   NOT NULL,
     nonce         BIGINT NOT NULL DEFAULT 0 CHECK (nonce >= 0),
     last_claim    BIGINT NOT NULL DEFAULT 0
   )`,
  // Compared case-insensitively, so "Alice" cannot shadow "alice".
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username))`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT   PRIMARY KEY,
     user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS entries (
     seq          ${idColumn},
     at           BIGINT NOT NULL,
     from_account TEXT   NOT NULL,
     to_account   TEXT   NOT NULL,
     amount       BIGINT NOT NULL CHECK (amount > 0),
     reason       TEXT   NOT NULL,
     CHECK (from_account <> to_account)
   )`,
  `CREATE INDEX IF NOT EXISTS entries_from ON entries (from_account)`,
  `CREATE INDEX IF NOT EXISTS entries_to ON entries (to_account)`,
];

/** Applies the schema. Safe to run repeatedly. */
export async function migrate(db: Db, dialect: "sqlite" | "postgres"): Promise<void> {
  const idColumn =
    dialect === "postgres"
      ? "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
      : "INTEGER PRIMARY KEY AUTOINCREMENT";
  for (const statement of STATEMENTS(idColumn)) {
    await db.run(statement);
  }
}
