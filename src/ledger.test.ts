import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUSE, MINT, playerAccount } from "./accounts.js";
import { Ledger, LedgerCorruptError } from "./ledger.js";
import { InsufficientChipsError, InvalidAmountError } from "./types.js";

describe("Ledger", () => {
  it("keeps the books at zero after every posting", () => {
    const ledger = new Ledger(() => 0);
    const alice = playerAccount("alice");
    ledger.post(MINT, alice, 1000, "faucet", true);
    ledger.post(alice, HOUSE, 250, "bet");
    ledger.post(HOUSE, alice, 490, "payout", true);
    ledger.assertBalanced();

    let total = 0;
    for (const balance of ledger.balances().values()) total += balance;
    assert.equal(total, 0);
  });

  it("derives balances from the entry log", () => {
    const ledger = new Ledger(() => 0);
    const alice = playerAccount("alice");
    ledger.post(MINT, alice, 1000, "faucet", true);
    ledger.post(alice, HOUSE, 300, "bet");

    assert.equal(ledger.balanceOf(alice), 700);
    assert.equal(ledger.balanceOf(HOUSE), 300);
    assert.equal(ledger.balanceOf(MINT), -1000);
    assert.equal(ledger.inCirculation(MINT), 1000);
  });

  it("refuses to overdraw an account that is not allowed to overdraft", () => {
    const ledger = new Ledger(() => 0);
    const alice = playerAccount("alice");
    ledger.post(MINT, alice, 100, "faucet", true);
    assert.throws(() => ledger.post(alice, HOUSE, 101, "bet"), InsufficientChipsError);
    // The failed posting left nothing behind.
    assert.equal(ledger.size, 1);
    assert.equal(ledger.balanceOf(alice), 100);
    ledger.assertBalanced();
  });

  it("rejects amounts that are not positive whole chips", () => {
    const ledger = new Ledger(() => 0);
    const alice = playerAccount("alice");
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
      assert.throws(() => ledger.post(MINT, alice, bad as number, "x", true), InvalidAmountError);
    }
  });

  it("rejects a posting from an account to itself", () => {
    const ledger = new Ledger(() => 0);
    assert.throws(() => ledger.post(HOUSE, HOUSE, 10, "noop", true), /itself/);
  });

  it("numbers entries in order and records the reason", () => {
    const ledger = new Ledger(() => 1234);
    const alice = playerAccount("alice");
    ledger.post(MINT, alice, 10, "faucet", true);
    ledger.post(alice, HOUSE, 4, "bet");

    const [first, second] = ledger.entries;
    assert.equal(first?.seq, 1);
    assert.equal(first?.reason, "faucet");
    assert.equal(first?.at, 1234);
    assert.equal(second?.seq, 2);
    assert.equal(second?.reason, "bet");
  });

  it("stays balanced across many randomised movements", () => {
    const ledger = new Ledger(() => 0);
    const players = ["a", "b", "c"].map(playerAccount);
    for (const p of players) ledger.post(MINT, p, 10_000, "faucet", true);

    for (let i = 0; i < 2000; i++) {
      const from = players[i % players.length]!;
      const stake = (i % 97) + 1;
      if (ledger.balanceOf(from) < stake) continue;
      ledger.post(from, HOUSE, stake, "bet");
      if (i % 2 === 0) ledger.post(HOUSE, from, stake, "payout", true);
    }

    ledger.assertBalanced();
    for (const p of players) assert.ok(ledger.balanceOf(p) >= 0, `${p} went negative`);
  });

  it("detects books that have been tampered with", () => {
    const ledger = new Ledger(() => 0);
    const alice = playerAccount("alice");
    ledger.post(MINT, alice, 100, "faucet", true);
    // Reach past the API to simulate corruption the class itself cannot cause.
    (ledger.balances as unknown as () => Map<string, number>) = () => new Map();
    const tampered = ledger as unknown as { balanceOf(a: string): number };
    tampered.balanceOf = (a: string) => (a === alice ? 999 : 0);
    assert.throws(() => ledger.assertBalanced(), LedgerCorruptError);
  });
});
