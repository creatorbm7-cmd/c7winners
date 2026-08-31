import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createDatabase } from "./database.js";

/**
 * The first boot after a volume is attached is the case these cover: the
 * directory the database belongs in may not exist yet, and if opening fails the
 * process dies before it listens — so the message it dies with is the only
 * evidence anyone gets.
 */
describe("choosing a database", () => {
  const root = mkdtempSync(join(tmpdir(), "c7-db-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("makes the directory the file belongs in", () => {
    const path = join(root, "mounted", "nested", "c7winners.db");
    const { dialect } = createDatabase({ sqlitePath: path });
    assert.equal(dialect, "sqlite");
    assert.ok(existsSync(path), "the database file was not created");
  });

  it("opens a file next to the process without inventing a directory", () => {
    const { dialect } = createDatabase({ sqlitePath: ":memory:" });
    assert.equal(dialect, "sqlite");
  });

  it("names the path and the user when it cannot open one", () => {
    // A file where a directory has to be: the open cannot succeed, and the
    // message has to say which path rather than "SQLITE_CANTOPEN".
    const blocked = join(root, "not-a-directory");
    createDatabase({ sqlitePath: blocked });
    assert.throws(
      () => createDatabase({ sqlitePath: join(blocked, "c7winners.db") }),
      (err) => {
        const message = (err as Error).message;
        assert.match(message, /c7winners\.db/, "the message does not name the path");
        assert.match(message, /uid \d+/, "the message does not say who it is running as");
        return true;
      },
    );
  });

  it("takes Postgres when a connection string is set", () => {
    const { dialect } = createDatabase({ connectionString: "postgres://u@h/db" });
    assert.equal(dialect, "postgres");
  });
});
