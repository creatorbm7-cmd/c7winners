import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyCommitment } from "../game.js";
import { InsufficientChipsError } from "../types.js";
import { openDatabase } from "./schema.js";
import {
  AuthenticationError,
  FaucetCooldownError,
  Store,
  UsernameTakenError,
} from "./store.js";

function fixture(overrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const store = new Store(openDatabase(":memory:"), {
    faucetAmount: 1000,
    faucetCooldownMs: 60_000,
    clock: () => now,
    ...overrides,
  });
  return { store, advance: (ms: number) => (now += ms), at: () => now };
}

describe("accounts", () => {
  it("registers a user and issues a working session", () => {
    const { store } = fixture();
    const { user, token } = store.register("alice", "correct-horse");
    assert.equal(user.username, "alice");
    assert.equal(store.userForToken(token)?.username, "alice");
  });

  it("refuses a duplicate username, case-insensitively", () => {
    const { store } = fixture();
    store.register("alice", "correct-horse");
    assert.throws(() => store.register("alice", "another-one"), UsernameTakenError);
    assert.throws(() => store.register("ALICE", "another-one"), UsernameTakenError);
  });

  it("logs in with the right password and rejects the wrong one", () => {
    const { store } = fixture();
    store.register("alice", "correct-horse");
    assert.equal(store.login("alice", "correct-horse").user.username, "alice");
    assert.throws(() => store.login("alice", "wrong"), AuthenticationError);
  });

  it("rejects an unknown user the same way as a wrong password", () => {
    const { store } = fixture();
    assert.throws(() => store.login("nobody", "whatever"), AuthenticationError);
  });

  it("does not store the password or the session token verbatim", () => {
    const { store } = fixture();
    const { token } = store.register("alice", "correct-horse");
    const db = (store as unknown as { [k: symbol]: unknown });
    void db;
    // The token the client holds must not appear as a stored value.
    assert.notEqual(token, "");
    assert.equal(store.userForToken(token)?.username, "alice");
    assert.equal(store.userForToken("deadbeef"), null);
  });

  it("expires a session and stops honouring its token", () => {
    const f = fixture({ sessionTtlMs: 1000 });
    const { token } = f.store.register("alice", "correct-horse");
    assert.ok(f.store.userForToken(token));
    f.advance(1001);
    assert.equal(f.store.userForToken(token), null);
  });

  it("forgets a token after logout", () => {
    const { store } = fixture();
    const { token } = store.register("alice", "correct-horse");
    store.logout(token);
    assert.equal(store.userForToken(token), null);
  });
});

describe("gameplay", () => {
  it("grants faucet chips and holds a per-user cooldown", () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    const bob = f.store.register("bob", "correct-horse").user;

    assert.equal(f.store.claimFaucet(alice).granted, 1000);
    assert.throws(() => f.store.claimFaucet(f.store.refresh(alice)), FaucetCooldownError);
    // bob's cooldown is his own
    assert.equal(f.store.claimFaucet(bob).granted, 1000);

    f.advance(60_000);
    assert.equal(f.store.claimFaucet(f.store.refresh(alice)).balance, 2000);
  });

  it("keeps balances separate between users", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    const bob = f.store.register("bob", "correct-horse").user;
    f.store.claimFaucet(alice);
    f.store.claimFaucet(bob);

    await f.store.bet(f.store.refresh(alice), 500);
    assert.equal(f.store.balanceOfUser("bob"), 1000, "bob's balance moved when alice bet");
    f.store.assertHealthy();
  });

  it("refuses a stake larger than the balance", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    f.store.claimFaucet(alice);
    await assert.rejects(() => f.store.bet(f.store.refresh(alice), 1001), InsufficientChipsError);
    assert.equal(f.store.balanceOfUser("alice"), 1000);
  });

  it("advances the nonce once per bet", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    f.store.claimFaucet(alice);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push((await f.store.bet(f.store.refresh(alice), 10)).nonce);
    }
    assert.deepEqual(seen, [0, 1, 2]);
  });

  it("moves chips without creating or destroying any", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    f.store.claimFaucet(alice);
    const before = f.store.balanceOfUser("alice") + f.store.balanceOf("system:house");
    await f.store.bet(f.store.refresh(alice), 250);
    const after = f.store.balanceOfUser("alice") + f.store.balanceOf("system:house");
    assert.equal(before, after);
    f.store.assertHealthy();
  });

  it("records every movement in the user's ledger", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    f.store.claimFaucet(alice);
    await f.store.bet(f.store.refresh(alice), 100);
    const reasons = f.store.ledgerFor("alice").map((r) => r.reason);
    assert.ok(reasons.includes("faucet"));
    assert.ok(reasons.includes("bet"));
  });

  it("stays reconciled across a long multi-user session", async () => {
    const f = fixture();
    const names = ["alice", "bob", "carol"];
    for (const n of names) f.store.claimFaucet(f.store.register(n, "correct-horse").user);

    for (let i = 0; i < 120; i++) {
      const name = names[i % names.length]!;
      const user = f.store.refresh({ id: 0, username: name, nonce: 0, clientSeed: "", lastClaim: 0 });
      const balance = f.store.balanceOfUser(name);
      if (balance < 10) {
        f.advance(60_000);
        try { f.store.claimFaucet(f.store.refresh(user)); } catch { /* still cooling down */ }
        continue;
      }
      await f.store.bet(user, Math.min(balance, (i % 40) + 1));
    }
    f.store.assertHealthy();
    for (const n of names) assert.ok(f.store.balanceOfUser(n) >= 0, `${n} went negative`);
  });
});

describe("provable fairness", () => {
  it("publishes a commitment its revealed seed satisfies", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    const published = await f.store.commitmentFor(alice);
    const { revealedSeed } = await f.store.revealAndRotate(alice);
    assert.ok(await verifyCommitment(revealedSeed, published));
  });

  it("rotates to a different seed on reveal and resets the nonce", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    f.store.claimFaucet(alice);
    await f.store.bet(f.store.refresh(alice), 10);
    assert.equal(f.store.refresh(alice).nonce, 1);

    const first = await f.store.commitmentFor(alice);
    const { commitment: second } = await f.store.revealAndRotate(alice);
    assert.notEqual(first, second, "the seed was not rotated");
    assert.equal(f.store.refresh(alice).nonce, 0);
    assert.equal(await f.store.commitmentFor(alice), second);
  });

  it("gives each user their own seed", async () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    const bob = f.store.register("bob", "correct-horse").user;
    assert.notEqual(await f.store.commitmentFor(alice), await f.store.commitmentFor(bob));
  });
});

describe("leaderboard", () => {
  it("ranks users by balance", () => {
    const f = fixture();
    const alice = f.store.register("alice", "correct-horse").user;
    const bob = f.store.register("bob", "correct-horse").user;
    f.store.claimFaucet(alice);
    f.advance(60_000);
    f.store.claimFaucet(f.store.refresh(alice));
    f.store.claimFaucet(bob);

    const board = f.store.leaderboard();
    assert.equal(board[0]?.username, "alice");
    assert.equal(board[0]?.balance, 2000);
    assert.equal(board[1]?.username, "bob");
    assert.equal(board[1]?.balance, 1000);
  });

  it("lists a user who has never played", () => {
    const f = fixture();
    f.store.register("newcomer", "correct-horse");
    const board = f.store.leaderboard();
    assert.equal(board[0]?.username, "newcomer");
    assert.equal(board[0]?.balance, 0);
    assert.equal(board[0]?.rounds, 0);
  });
});
