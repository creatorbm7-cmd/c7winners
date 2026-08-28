import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyCommitment } from "../game.js";
import { InsufficientChipsError } from "../types.js";
import { migrate } from "./schema.js";
import { testDatabases, type TestEngine } from "./testing.js";
import {
  AuthenticationError,
  FaucetCooldownError,
  Store,
  UsernameTakenError,
} from "./store.js";

/**
 * Every store test runs against both engines.
 *
 * The point of the adapter is that one set of SQL behaves the same on SQLite and
 * Postgres. Testing one of them would leave that claim unchecked, and the
 * differences that actually bite — placeholder numbering, case-insensitive
 * uniqueness, BIGINT arriving as a string — surface here rather than in
 * production.
 */
const ENGINES = await testDatabases();
const PASSWORD = "correct-horse";

async function fixture(engine: TestEngine, overrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const db = await engine.open();
  await migrate(db, engine.dialect);
  const store = new Store(db, {
    faucetAmount: 1000,
    faucetCooldownMs: 60_000,
    clock: () => now,
    ...overrides,
  });
  return { store, advance: (ms: number) => (now += ms) };
}

for (const engine of ENGINES) {
  describe(`accounts (${engine.name})`, () => {
    it("registers a user and issues a working session", async () => {
      const { store } = await fixture(engine);
      const { user, token } = await store.register("alice", PASSWORD);
      assert.equal(user.username, "alice");
      assert.equal((await store.userForToken(token))?.username, "alice");
    });

    it("refuses a duplicate username, case-insensitively", async () => {
      const { store } = await fixture(engine);
      await store.register("alice", PASSWORD);
      await assert.rejects(() => store.register("alice", PASSWORD), UsernameTakenError);
      await assert.rejects(() => store.register("ALICE", PASSWORD), UsernameTakenError);
    });

    it("signs in with the right password and refuses the wrong one", async () => {
      const { store } = await fixture(engine);
      await store.register("alice", PASSWORD);
      assert.equal((await store.login("alice", PASSWORD)).user.username, "alice");
      await assert.rejects(() => store.login("alice", "wrong"), AuthenticationError);
    });

    it("signs in regardless of the case typed", async () => {
      const { store } = await fixture(engine);
      await store.register("alice", PASSWORD);
      assert.equal((await store.login("ALICE", PASSWORD)).user.username, "alice");
    });

    it("refuses an unknown user the same way as a wrong password", async () => {
      const { store } = await fixture(engine);
      await assert.rejects(() => store.login("nobody", "whatever"), AuthenticationError);
    });

    it("rejects a token it never issued", async () => {
      const { store } = await fixture(engine);
      await store.register("alice", PASSWORD);
      assert.equal(await store.userForToken("deadbeef"), null);
    });

    it("expires a session and stops honouring its token", async () => {
      const f = await fixture(engine, { sessionTtlMs: 1000 });
      const { token } = await f.store.register("alice", PASSWORD);
      assert.ok(await f.store.userForToken(token));
      f.advance(1001);
      assert.equal(await f.store.userForToken(token), null);
    });

    it("forgets a token after logout", async () => {
      const { store } = await fixture(engine);
      const { token } = await store.register("alice", PASSWORD);
      await store.logout(token);
      assert.equal(await store.userForToken(token), null);
    });
  });

  describe(`gameplay (${engine.name})`, () => {
    it("grants faucet chips and holds a per-user cooldown", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      const bob = (await f.store.register("bob", PASSWORD)).user;

      assert.equal((await f.store.claimFaucet(alice)).granted, 1000);
      await assert.rejects(
        async () => f.store.claimFaucet(await f.store.refresh(alice)),
        FaucetCooldownError,
      );
      assert.equal((await f.store.claimFaucet(bob)).granted, 1000, "bob inherited alice's cooldown");

      f.advance(60_000);
      assert.equal((await f.store.claimFaucet(await f.store.refresh(alice))).balance, 2000);
    });

    it("keeps balances separate between users", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      const bob = (await f.store.register("bob", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      await f.store.claimFaucet(bob);

      await f.store.bet(await f.store.refresh(alice), 500);
      assert.equal(await f.store.balanceOfUser("bob"), 1000, "bob's balance moved when alice bet");
      await f.store.assertHealthy();
    });

    it("refuses a stake larger than the balance", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      await assert.rejects(
        async () => f.store.bet(await f.store.refresh(alice), 1001),
        InsufficientChipsError,
      );
      assert.equal(await f.store.balanceOfUser("alice"), 1000);
    });

    it("advances the nonce once per bet", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      const seen: number[] = [];
      for (let i = 0; i < 3; i++) {
        seen.push((await f.store.bet(await f.store.refresh(alice), 10)).nonce);
      }
      assert.deepEqual(seen, [0, 1, 2]);
    });

    it("moves chips without creating or destroying any", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      const before =
        (await f.store.balanceOfUser("alice")) + (await f.store.balanceOf("system:house"));
      await f.store.bet(await f.store.refresh(alice), 250);
      const after =
        (await f.store.balanceOfUser("alice")) + (await f.store.balanceOf("system:house"));
      assert.equal(before, after);
      await f.store.assertHealthy();
    });

    it("returns whole-chip balances, not strings", async () => {
      // Postgres hands BIGINT back as a string unless it is converted; a balance
      // that arrives as "1000" compares and adds nothing like a number.
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      const balance = await f.store.balanceOfUser("alice");
      assert.equal(typeof balance, "number");
      assert.equal(balance, 1000);
      assert.equal(balance + 1, 1001);
    });

    it("records every movement in the user's ledger", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      await f.store.bet(await f.store.refresh(alice), 100);
      const reasons = (await f.store.ledgerFor("alice")).map((r) => r.reason);
      assert.ok(reasons.includes("faucet"));
      assert.ok(reasons.includes("bet"));
    });

    it("stays reconciled across a long multi-user session", async () => {
      const f = await fixture(engine);
      const names = ["alice", "bob", "carol"];
      for (const n of names) await f.store.claimFaucet((await f.store.register(n, PASSWORD)).user);

      for (let i = 0; i < 60; i++) {
        const name = names[i % names.length]!;
        const balance = await f.store.balanceOfUser(name);
        if (balance < 10) {
          f.advance(60_000);
          const user = await f.store.refresh({ id: 0, username: name, nonce: 0, clientSeed: "", lastClaim: 0 });
          try {
            await f.store.claimFaucet(user);
          } catch {
            // still cooling down
          }
          continue;
        }
        const user = await f.store.refresh({ id: 0, username: name, nonce: 0, clientSeed: "", lastClaim: 0 });
        await f.store.bet(user, Math.min(balance, (i % 40) + 1));
      }
      await f.store.assertHealthy();
      for (const n of names) {
        assert.ok((await f.store.balanceOfUser(n)) >= 0, `${n} went negative`);
      }
    });
  });

  describe(`provable fairness (${engine.name})`, () => {
    it("publishes a commitment its revealed seed satisfies", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      const published = await f.store.commitmentFor(alice);
      const { revealedSeed } = await f.store.revealAndRotate(alice);
      assert.ok(await verifyCommitment(revealedSeed, published));
    });

    it("rotates to a different seed on reveal and resets the nonce", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      await f.store.bet(await f.store.refresh(alice), 10);
      assert.equal((await f.store.refresh(alice)).nonce, 1);

      const first = await f.store.commitmentFor(alice);
      const { commitment: second } = await f.store.revealAndRotate(alice);
      assert.notEqual(first, second, "the seed was not rotated");
      assert.equal((await f.store.refresh(alice)).nonce, 0);
      assert.equal(await f.store.commitmentFor(alice), second);
    });

    it("gives each user their own seed", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      const bob = (await f.store.register("bob", PASSWORD)).user;
      assert.notEqual(await f.store.commitmentFor(alice), await f.store.commitmentFor(bob));
    });
  });

  describe(`leaderboard (${engine.name})`, () => {
    it("ranks users by balance", async () => {
      const f = await fixture(engine);
      const alice = (await f.store.register("alice", PASSWORD)).user;
      const bob = (await f.store.register("bob", PASSWORD)).user;
      await f.store.claimFaucet(alice);
      f.advance(60_000);
      await f.store.claimFaucet(await f.store.refresh(alice));
      await f.store.claimFaucet(bob);

      const board = await f.store.leaderboard();
      assert.equal(board[0]?.username, "alice");
      assert.equal(board[0]?.balance, 2000);
      assert.equal(board[1]?.username, "bob");
      assert.equal(board[1]?.balance, 1000);
    });

    it("lists a user who has never played", async () => {
      const f = await fixture(engine);
      await f.store.register("newcomer", PASSWORD);
      const board = await f.store.leaderboard();
      assert.equal(board[0]?.username, "newcomer");
      assert.equal(board[0]?.balance, 0);
      assert.equal(board[0]?.rounds, 0);
    });
  });
}
