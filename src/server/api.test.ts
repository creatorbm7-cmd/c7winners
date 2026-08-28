import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { createApi } from "./api.js";
import { openDatabase } from "./schema.js";
import { Store } from "./store.js";

/** Spins up the API on an ephemeral port and returns a client bound to it. */
async function serve(options: Record<string, unknown> = {}) {
  const store = new Store(openDatabase(":memory:"), { faucetAmount: 1000, ...options });
  const api = createApi(store);
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!(await api(req, res))) {
        res.writeHead(404).end("not api");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  return { store, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("API", () => {
  it("registers, then authenticates the returned token", async () => {
    const s = await serve();
    after(s.close);
    const reg = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.username, "alice");
    assert.equal(reg.json.balance, 0);
    assert.ok(reg.json.token);
    assert.ok(reg.json.commitment, "no seed commitment published");

    const me = await s.call("GET", "/api/me", undefined, reg.json.token);
    assert.equal(me.status, 200);
    assert.equal(me.json.username, "alice");
  });

  it("never returns the server seed before a reveal", async () => {
    const s = await serve();
    after(s.close);
    const reg = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    const me = await s.call("GET", "/api/me", undefined, reg.json.token);
    const serialised = JSON.stringify(me.json);
    assert.ok(!("serverSeed" in me.json), "the server seed was exposed");
    assert.ok(!/server_seed/.test(serialised));
  });

  it("rejects weak or malformed credentials", async () => {
    const s = await serve();
    after(s.close);
    for (const body of [
      { username: "ab", password: "correct-horse" },
      { username: "has space", password: "correct-horse" },
      { username: "alice", password: "short" },
      { username: 42, password: "correct-horse" },
    ]) {
      const res = await s.call("POST", "/api/register", body);
      assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
  });

  it("refuses a duplicate registration", async () => {
    const s = await serve();
    after(s.close);
    await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    const again = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    assert.equal(again.status, 409);
  });

  it("requires a valid token on protected routes", async () => {
    const s = await serve();
    after(s.close);
    for (const [method, path] of [["GET", "/api/me"], ["POST", "/api/faucet"], ["POST", "/api/bet"], ["GET", "/api/ledger"]] as const) {
      assert.equal((await s.call(method, path, method === "POST" ? {} : undefined)).status, 401, `${path} was open`);
      assert.equal((await s.call(method, path, method === "POST" ? {} : undefined, "bogus")).status, 401, `${path} took a bogus token`);
    }
  });

  it("claims the faucet then reports the cooldown", async () => {
    const s = await serve({ faucetCooldownMs: 60_000 });
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    const first = await s.call("POST", "/api/faucet", {}, reg.token);
    assert.equal(first.status, 200);
    assert.equal(first.json.balance, 1000);

    const second = await s.call("POST", "/api/faucet", {}, reg.token);
    assert.equal(second.status, 429);
    assert.ok(second.json.nextClaimAt > 0);
  });

  it("places a bet and moves the balance by the net", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    await s.call("POST", "/api/faucet", {}, reg.token);
    const bet = await s.call("POST", "/api/bet", { stake: 100 }, reg.token);
    assert.equal(bet.status, 200);
    assert.equal(bet.json.balance, 1000 + bet.json.net);
    assert.equal(bet.json.net, bet.json.payout - 100);
    assert.ok(bet.json.roll >= 0 && bet.json.roll < 1);
  });

  it("rejects stakes that are not positive whole chips", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    await s.call("POST", "/api/faucet", {}, reg.token);
    for (const stake of [0, -5, 1.5, "100", null, 1e400]) {
      const res = await s.call("POST", "/api/bet", { stake }, reg.token);
      assert.equal(res.status, 400, `accepted stake ${String(stake)}`);
    }
  });

  it("refuses a stake beyond the balance", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    await s.call("POST", "/api/faucet", {}, reg.token);
    const res = await s.call("POST", "/api/bet", { stake: 5000 }, reg.token);
    assert.equal(res.status, 400);
    assert.equal(res.json.balance, 1000);
  });

  it("keeps two players' balances independent", async () => {
    const s = await serve();
    after(s.close);
    const a = (await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" })).json;
    const b = (await s.call("POST", "/api/register", { username: "bob", password: "correct-horse" })).json;
    await s.call("POST", "/api/faucet", {}, a.token);
    await s.call("POST", "/api/faucet", {}, b.token);
    await s.call("POST", "/api/bet", { stake: 900 }, a.token);

    const bob = await s.call("GET", "/api/me", undefined, b.token);
    assert.equal(bob.json.balance, 1000, "bob's balance moved when alice bet");
  });

  it("reveals a seed that verifies against the published commitment", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    const published = reg.commitment;
    const reveal = await s.call("POST", "/api/fairness/reveal", {}, reg.token);
    assert.equal(reveal.status, 200);

    const { verifyCommitment } = await import("../game.js");
    assert.ok(await verifyCommitment(reveal.json.revealedSeed, published));
    assert.notEqual(reveal.json.commitment, published, "the seed was not rotated");
  });

  it("serves a leaderboard without a token", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    await s.call("POST", "/api/faucet", {}, reg.token);
    const board = await s.call("GET", "/api/leaderboard");
    assert.equal(board.status, 200);
    assert.equal(board.json.players[0].username, "alice");
    assert.equal(board.json.players[0].balance, 1000);
  });

  it("stops honouring a token after logout", async () => {
    const s = await serve();
    after(s.close);
    const { json: reg } = await s.call("POST", "/api/register", { username: "alice", password: "correct-horse" });
    await s.call("POST", "/api/logout", {}, reg.token);
    assert.equal((await s.call("GET", "/api/me", undefined, reg.token)).status, 401);
  });

  it("reports health from the books", async () => {
    const s = await serve();
    after(s.close);
    const res = await s.call("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it("404s an unknown endpoint and rejects an oversized body", async () => {
    const s = await serve();
    after(s.close);
    assert.equal((await s.call("GET", "/api/nope")).status, 404);
    const big = { username: "a".repeat(9000), password: "correct-horse" };
    assert.equal((await s.call("POST", "/api/register", big)).status, 400);
  });
});
