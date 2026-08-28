import { DatabaseSync } from "node:sqlite";

/**
 * The database schema.
 *
 * The ledger keeps its defining property here rather than only in application
 * code: entries are append-only and balances are a SUM over them, so there is no
 * stored balance that can drift from its own history. The CHECK constraints
 * restate the rules `Ledger.post()` enforces, so a bug in the server cannot write
 * a movement the domain forbids.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  -- The server seed never leaves the server until the player rotates it. That
  -- is what makes the commit-reveal scheme a guarantee rather than a gesture.
  server_seed   TEXT    NOT NULL,
  client_seed   TEXT    NOT NULL,
  nonce         INTEGER NOT NULL DEFAULT 0 CHECK (nonce >= 0),
  last_claim    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS entries (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  from_account TEXT    NOT NULL,
  to_account   TEXT    NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  reason       TEXT    NOT NULL,
  CHECK (from_account <> to_account)
);
CREATE INDEX IF NOT EXISTS entries_from ON entries(from_account);
CREATE INDEX IF NOT EXISTS entries_to   ON entries(to_account);
`;

/** Opens a database and applies the schema. `:memory:` gives a throwaway one. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
