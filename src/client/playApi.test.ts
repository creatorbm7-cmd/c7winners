import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApi } from "../server/api.js";
import { SqliteDb } from "../server/db-sqlite.js";
import { migrate } from "../server/schema.js";
import { Store } from "../server/store.js";
import { PlayApi, PlayApiError, reelFaces, type BetOutcome } from "./playApi.js";

/**
 * The client against the real server, over real HTTP.
 *
 * The point of these is not the client's internals but the contract between the
 * two: a renamed field or a moved route breaks them here rather than in someone
 * else's browser.
 */
async function connect() {
  const db = new SqliteDb(":memory:");
  await migrate(db, "sqlite");
  const store = new Store(db, { faucetAmount: 1000, faucetCooldownMs: 60_000 });
  const api = createApi(store);
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!(await api(req, res))) res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    client: new PlayApi({ baseUrl: `http://127.0.0.1:${port}/api` }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const creds = ["reel-player", "correct horse battery"] as const;

describe("play API client", () => {
  it("registers, claims and plays a round", async () => {
    const { client, close } = await connect();
    after(close);

    const session = await client.register(...creds);
    assert.equal(session.username, "reel-player");
    assert.ok(session.token, "no token");
    assert.equal(session.capabilities.deposits, false);

    const claim = await client.faucet();
    assert.equal(claim.granted, 1000);
    assert.equal(claim.balance, 1000);

    const outcome = await client.bet(100);
    assert.equal(outcome.stake, 100);
    assert.equal(outcome.balance, outcome.won ? 900 + outcome.payout : 900);

    const entries = await client.ledger();
    assert.deepEqual(
      entries.map((e) => e.reason).slice(-2),
      ["bet", "faucet"],
      "the ledger should read newest first",
    );
  });

  it("keeps the token, and drops it on logout", async () => {
    const { client, close } = await connect();
    after(close);
    await client.register(...creds);
    assert.equal((await client.me()).username, "reel-player");
    await client.logout();
    assert.equal(client.token, null);
    await assert.rejects(() => client.me(), (err) => (err as PlayApiError).status === 401);
  });

  it("reports a stake the player cannot cover, with the balance", async () => {
    const { client, close } = await connect();
    after(close);
    await client.register(...creds);
    await client.faucet();
    const err = await client.bet(5000).then(
      () => null,
      (e: unknown) => e as PlayApiError,
    );
    assert.equal(err?.status, 400);
    assert.equal(err?.balance, 1000);
  });

  it("reports the faucet cooldown with the time it ends", async () => {
    const { client, close } = await connect();
    after(close);
    await client.register(...creds);
    await client.faucet();
    const err = await client.faucet().then(
      () => null,
      (e: unknown) => e as PlayApiError,
    );
    assert.equal(err?.status, 429);
    assert.ok((err?.nextClaimAt ?? 0) > Date.now(), "no nextClaimAt to count down from");
  });

  it("carries the fairness chain", async () => {
    const { client, close } = await connect();
    after(close);
    const before = await client.register(...creds);
    await client.faucet();
    await client.bet(10);
    const seeded = await client.setClientSeed("my-own-seed");
    assert.equal(seeded.clientSeed, "my-own-seed");
    const revealed = await client.revealAndRotate();
    assert.ok(revealed.revealedSeed, "nothing revealed");
    assert.notEqual(revealed.commitment, before.commitment, "the seed did not rotate");
    assert.equal((await client.me()).nonce, 0);
  });

  it("reads the public views without a session", async () => {
    const { client, close } = await connect();
    after(close);
    assert.equal(await client.healthy(), true);
    const status = await client.status();
    assert.equal(status.capabilities.realMoneyEngine, false);
    assert.deepEqual(status.cors.allowedOrigins, []);
    assert.deepEqual(await client.leaderboard(), []);
  });
});

describe("reel faces", () => {
  const round = (won: boolean, roll: number): BetOutcome => ({
    won,
    roll,
    stake: 10,
    payout: won ? 19 : 0,
    net: won ? 9 : -10,
    nonce: 1,
    balance: 100,
  });

  it("lines up on a win", () => {
    for (const roll of [0, 0.1, 0.31, 0.49999]) {
      const faces = reelFaces(round(true, roll));
      assert.equal(new Set(faces).size, 1, `roll ${roll} did not line up`);
    }
  });

  it("never lines up on a loss", () => {
    for (let i = 0; i < 500; i++) {
      const faces = reelFaces(round(false, i / 500));
      assert.ok(new Set(faces).size > 1, `roll ${i / 500} showed a winning row on a loss`);
    }
  });

  it("shows the same reels for the same round", () => {
    assert.deepEqual(reelFaces(round(false, 0.7231)), reelFaces(round(false, 0.7231)));
  });

  it("stays inside the strip it was given", () => {
    for (let i = 0; i < 200; i++) {
      for (const face of reelFaces(round(i % 2 === 0, i / 200), 5, 4)) {
        assert.ok(Number.isInteger(face) && face >= 0 && face < 5, `face ${face} is off the strip`);
      }
    }
  });

  it("refuses a strip that cannot show a loss", () => {
    assert.throws(() => reelFaces(round(false, 0.5), 1));
  });
});
