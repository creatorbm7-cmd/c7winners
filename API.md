# The play-money HTTP API

Everything the front end can ask the server to do. Twelve endpoints, all JSON,
all under `/api/`. This is the whole surface: there is no deposit, withdrawal,
wallet, payout or KYC endpoint anywhere in it, and there is no configuration
that adds one — see [What is not here](#what-is-not-here).

The route table this document describes is
[`src/server/api.ts`](src/server/api.ts); the shapes come from
[`src/server/store.ts`](src/server/store.ts).

## Talking to it

Requests are JSON objects; responses are JSON objects with
`content-type: application/json; charset=utf-8` and `cache-control: no-store`.
A `POST` body larger than 4 KB is refused. A body that is not a JSON object —
an array, a bare number, `null` — is a 400, not a coerced empty object.

Authentication is a bearer token from `/api/register` or `/api/login`:

```
Authorization: Bearer <token>
```

There are no cookies, so nothing here is exposed to CSRF. Tokens last 30 days
by default, and `/api/logout` ends one early.

Every failure carries a human-readable reason:

```json
{ "error": "You only have 40 chips.", "balance": 40 }
```

| Status | Means |
| --- | --- |
| 400 | The request was malformed — a missing field, a fractional stake, a username that fails validation |
| 401 | No token, or a token that has expired |
| 404 | No such endpoint |
| 409 | That username is taken |
| 429 | A rate limit; `retry-after` and `retryAfterMs` say how long |
| 500 | Something broke server-side. The response says only that; the detail goes to the server log |

### Which origins may call it

By default, only its own. The server sends no `Access-Control-Allow-Origin` and
answers `OPTIONS` with a 404, so a browser preflight fails and **a page served
from a different origin cannot read anything from this API.** That is the right
default: `serve:api` runs the API and the site in one process precisely so the
front end is same-origin and needs no permission at all.

A front end deployed somewhere else — a separate Vercel or Netlify project, say
— therefore cannot reach this API just by pointing a base-URL variable at it.
Three ways to fix that, in order of preference:

1. **Serve the front end from this server**, as `npm run serve:api` already does.
   The base URL is then `/api`, relative, and nothing cross-origin happens.
2. **Put both behind one hostname**, with the host's rewrite rules proxying
   `/api/*` to this server. The browser still sees one origin. Remember to raise
   `TRUST_PROXY` by one for the extra hop, or every request will arrive wearing
   the proxy's address and share one rate-limit bucket.
3. **Name the origin in `ALLOWED_ORIGINS`**, comma-separated:

   ```
   ALLOWED_ORIGINS=https://c7winners.com,http://localhost:5173
   ```

   Each listed origin gets `access-control-allow-origin` echoed back **by name**
   — never a wildcard — along with `vary: origin`. An unlisted origin gets no
   header, and its preflight is the same 404 as before. `authorization` and
   `content-type` are the allowed request headers; credentials are not enabled,
   because auth here is a bearer token the page attaches itself and cookies
   never need to ride along.

   Write bare origins: scheme and host, no trailing slash, no path, no `*`. The
   server refuses to start on anything else rather than accept a value that
   could only ever fail to match. A rate-limit refusal carries the CORS headers
   too, so a 429 reaches the page as a 429 instead of an unexplained network
   error.

## The endpoints

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `POST` | `/api/register` | — | Creates an account, returns a token |
| `POST` | `/api/login` | — | Returns a token |
| `POST` | `/api/logout` | token | Ends the session |
| `GET` | `/api/me` | token | The signed-in player's state |
| `POST` | `/api/faucet` | token | Claims free chips |
| `POST` | `/api/bet` | token | Plays one round |
| `GET` | `/api/ledger` | token | The player's last 25 ledger entries |
| `POST` | `/api/fairness/client-seed` | token | Sets the client seed |
| `POST` | `/api/fairness/reveal` | token | Reveals the server seed and rotates it |
| `GET` | `/api/leaderboard` | — | Top 10 balances |
| `GET` | `/api/status` | — | House aggregates and what this build can do |
| `GET` | `/api/health` | — | Liveness, for the deployment's health check |

### The player object

`register`, `login`, `me` and `fairness/client-seed` all return the same shape —
everything a screen needs to render the signed-in player:

```json
{
  "username": "asha",
  "balance": 1000,
  "nonce": 3,
  "clientSeed": "a1b2c3d4",
  "faucetReadyAt": 0,
  "faucetAmount": 1000,
  "commitment": "9f2c…",
  "rules": { "winChance": 0.5, "houseEdge": 0.02 },
  "capabilities": { "mode": "play-money", "deposits": false, "…": false }
}
```

`faucetReadyAt` is `0` when the faucet is ready now, otherwise the epoch
milliseconds when it will be. `commitment` is the SHA-256 of the current server
seed: the promise that the next roll was fixed before you bet it.

### `POST /api/register`

```json
{ "username": "asha", "password": "correct horse battery staple" }
```

A username is 3–24 characters of letters, numbers, hyphen or underscore; a
password is at least 8 characters. **201** with `{ "token": "…", …player }`.
**409** if the username is taken, **400** with the rule it broke, **429** after
5 accounts from one address in an hour.

### `POST /api/login`

Same body. **200** with `{ "token": "…", …player }`, **401** on a wrong
username or password. A correct password does not count against the limit.

### `POST /api/logout`

No body. Always **200** `{ "ok": true }`, whether or not the token was valid.

### `GET /api/me`

The player object, or **401**.

### `POST /api/faucet`

No body.

```json
{ "granted": 1000, "balance": 1000, "nextClaimAt": 1756500000000, "…player": "…" }
```

**429** with `{ "error": "…", "nextClaimAt": … }` while the cooldown is running.

### `POST /api/bet`

```json
{ "stake": 100, "clientSeed": "optional-new-seed" }
```

`stake` must be a **whole number** of chips, at least 1 — a string like `"100"`
or a fractional `10.5` is a 400, not a rounded value. `clientSeed` is optional;
sending one sets it before the roll, and it is truncated to 64 characters.

```json
{ "won": true, "roll": 0.4213, "stake": 100, "payout": 196, "net": 96, "nonce": 4, "balance": 1096 }
```

**400** with `{ "error": "You only have 40 chips.", "balance": 40 }` when the
stake exceeds the balance. **429** after 120 bets in a minute.

### `GET /api/ledger`

The player's own entries, newest first, 25 of them:

```json
{ "entries": [
  { "seq": 12, "at": 1756499000000, "from": "house", "to": "player:asha", "amount": 196, "reason": "payout" }
] }
```

`reason` is one of `faucet`, `bet`, `payout`.

### `POST /api/fairness/client-seed`

```json
{ "clientSeed": "whatever-you-like" }
```

Returns the player object. **400** on an empty seed.

### `POST /api/fairness/reveal`

No body. Reveals the seed your past rolls were made from and starts a new one,
so every earlier roll can be checked and the nonce goes back to zero:

```json
{ "revealedSeed": "…", "commitment": "…" }
```

### `GET /api/leaderboard`

```json
{ "players": [ { "username": "asha", "balance": 2140, "rounds": 37 } ] }
```

### `GET /api/status`

Public and aggregate — no usernames, no per-player figures — because the claim
it exists to support ("nothing here moves real money") is one anyone should be
able to check without an account. This is what
[`/control.html`](web/control.html) renders.

```json
{
  "capabilities": { "mode": "play-money", "currency": "PLAY", "realMoneyEngine": false,
                    "deposits": false, "withdrawals": false, "cashOut": false,
                    "requiresGamingLicence": false, "requiresPaymentProcessor": false },
  "rules": { "winChance": 0.5, "houseEdge": 0.02 },
  "build": { "commit": "9c98f6d…" },
  "cors": { "allowedOrigins": ["https://c7winners.com"] },
  "storage": { "engine": "sqlite", "createdThisBoot": false },
  "chipsInCirculation": 0, "housePosition": 0, "playerChips": 0,
  "ledgerEntries": 0, "players": 0,
  "booksReconcile": true, "negativeAccounts": 0
}
```

`build` and `cors` are here because a deployment is easy to get wrong and, until
now, impossible to check without a dashboard login: whether the commit you merged
is the one actually running, and which origins the server will answer. Neither is
a secret — the second is discoverable by asking with an `Origin` header — and
saying them plainly turns a dashboard hunt into one request. `build` is absent
when the platform never told the process which commit it built (Railway sets
`RAILWAY_GIT_COMMIT_SHA`; `GIT_COMMIT` works anywhere else), because a made-up
value would be worse than none.

`storage.createdThisBoot` is the one to watch on a deployment: `true` means no
database file existed when the process started. True once is a first deploy;
true again after a later deploy means the data is not on a volume and the
accounts are gone. `booksReconcile` asks whether every issued chip is still in
an account with a name — the mint, the house, or a player.

### `GET /api/health`

**200** `{ "ok": true }`, or **500** `{ "ok": false, "error": "…" }`. The
deployment's health check points here.

## Rate limits

Sized so a real player never meets them. Each is a token bucket; the response on
refusal carries `retry-after` in seconds and `retryAfterMs` in the body.

| Limit | Per | Allowance |
| --- | --- | --- |
| Every request | address | 300 / minute |
| `register` | address | 5 / hour |
| `login` | address | 10 / 15 minutes |
| `login` | username | 5 / 15 minutes |
| `bet` | player | 120 / minute |

The per-username sign-in limit is there because limiting by address alone leaves
one account open to a slow attempt from each of many addresses.

Behind a proxy, set `TRUST_PROXY` to the number of hops you control. Left at 0,
`X-Forwarded-For` is ignored entirely — otherwise a client could hand itself a
fresh rate-limit identity on every request.

## What is not here

There is no endpoint for depositing, withdrawing, buying chips, cashing out,
connecting a wallet, verifying identity, or paying anyone. Not disabled ones —
absent ones. A call to any such path gets the same answer as a typo:

```
$ curl -s https://…/api/deposit
{"error":"No such endpoint."}
```

The three functions that would name those operations live in
[`src/guards.ts`](src/guards.ts) and do nothing but throw
`RealMoneyUnsupportedError`, so "can this platform take a deposit?" has a single
greppable answer. `/api/status` reports `capabilities` from that same module
rather than from configuration, so the panel cannot advertise a capability the
build does not have.
