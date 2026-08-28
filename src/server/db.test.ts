import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toNumberedPlaceholders } from "./db.js";

describe("toNumberedPlaceholders", () => {
  it("numbers placeholders in order", () => {
    assert.equal(
      toNumberedPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("leaves a query without placeholders alone", () => {
    assert.equal(toNumberedPlaceholders("SELECT 1"), "SELECT 1");
  });

  it("does not touch a question mark inside a string literal", () => {
    assert.equal(
      toNumberedPlaceholders("SELECT 'why?' WHERE a = ?"),
      "SELECT 'why?' WHERE a = $1",
    );
  });

  it("handles an escaped quote inside a literal", () => {
    assert.equal(
      toNumberedPlaceholders("SELECT 'it''s a ?' WHERE a = ?"),
      "SELECT 'it''s a ?' WHERE a = $1",
    );
  });

  it("numbers repeated placeholders separately", () => {
    // Unlike SQLite's ?1 reuse, each ? is its own parameter, so callers must
    // pass the value once per occurrence.
    assert.equal(
      toNumberedPlaceholders("WHERE a = ? OR b = ? OR c = ?"),
      "WHERE a = $1 OR b = $2 OR c = $3",
    );
  });
});
