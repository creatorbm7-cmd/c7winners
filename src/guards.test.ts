import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITIES,
  RealMoneyUnsupportedError,
  assertPlayMoney,
  cashOut,
  deposit,
  withdraw,
} from "./guards.js";

describe("real-money interlocks", () => {
  it("refuses deposits", () => {
    assert.throws(() => deposit(), RealMoneyUnsupportedError);
  });

  it("refuses withdrawals", () => {
    assert.throws(() => withdraw(), RealMoneyUnsupportedError);
  });

  it("refuses cash-out", () => {
    assert.throws(() => cashOut(), RealMoneyUnsupportedError);
  });

  it("accepts play chips and rejects every other currency", () => {
    assert.doesNotThrow(() => assertPlayMoney("PLAY"));
    for (const currency of ["USD", "EUR", "USDT", "C74", "play", ""]) {
      assert.throws(() => assertPlayMoney(currency), RealMoneyUnsupportedError);
    }
  });

  it("explains what is required before real money is possible", () => {
    assert.throws(
      () => deposit(),
      (error: unknown) => {
        assert.ok(error instanceof RealMoneyUnsupportedError);
        assert.match(error.message, /licence/i);
        assert.match(error.message, /payment processor/i);
        assert.match(error.message, /reserve/i);
        return true;
      },
    );
  });

  it("reports capabilities that match the build", () => {
    assert.equal(CAPABILITIES.mode, "play-money");
    assert.equal(CAPABILITIES.currency, "PLAY");
    assert.equal(CAPABILITIES.realMoneyEngine, false);
    assert.equal(CAPABILITIES.deposits, false);
    assert.equal(CAPABILITIES.withdrawals, false);
    assert.equal(CAPABILITIES.cashOut, false);
  });

  it("does not let capabilities be edited at runtime", () => {
    assert.throws(() => {
      (CAPABILITIES as unknown as { deposits: boolean }).deposits = true;
    }, TypeError);
    assert.equal(CAPABILITIES.deposits, false);
  });
});
