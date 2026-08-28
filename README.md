# c7winners

> [!IMPORTANT]
> **Play money only.** Chips in this platform are issued by a faucet, have no
> cash value, and cannot be bought, sold, or cashed out. There is no real-money
> engine, no deposit path and no withdrawal path in this codebase — not disabled
> ones, absent ones. See [Play-money interlocks](#play-money-interlocks).

## Getting started

```bash
git clone https://github.com/creatorbm7-cmd/c7winners.git
cd c7winners
./scripts/setup.sh   # install dependencies
./scripts/check.sh   # run linters and tests
npm run demo         # play a short session in the terminal
npm run build:web    # build the static front end into dist-web/
npm run serve:api    # run the server (API + site) on localhost:8080
```

`npm run serve:api` serves the API and the front end from one process, so the
page is same-origin with its API. See [DEPLOY.md](DEPLOY.md) to put it online.

## Multi-user server

Accounts, balances and game state live server-side in SQLite. The front end
renders and sends actions; it decides nothing.

| Path | Purpose |
| --- | --- |
| `src/server/schema.ts` | Tables. Balances are a SUM over append-only entries, never a column |
| `src/server/store.ts` | Users, sessions, ledger, gameplay, leaderboard |
| `src/server/auth.ts` | scrypt password hashing, hashed session tokens |
| `src/server/api.ts` | JSON HTTP API |
| `src/server/main.ts` | Server entrypoint: API plus the static site |

### API

| Endpoint | Auth | Does |
| --- | --- | --- |
| `POST /api/register` | — | Create an account, returns a bearer token |
| `POST /api/login` | — | Sign in, returns a bearer token |
| `POST /api/logout` | token | Invalidate the token |
| `GET /api/me` | token | Balance, nonce, seed commitment, faucet state |
| `POST /api/faucet` | token | Claim free chips (429 while on cooldown) |
| `POST /api/bet` | token | Place a bet: `{stake}` |
| `GET /api/ledger` | token | Recent entries for this player |
| `POST /api/fairness/reveal` | token | Reveal the server seed and rotate to a fresh one |
| `POST /api/fairness/client-seed` | token | Set your own seed |
| `GET /api/leaderboard` | — | Top players by balance |
| `GET /api/health` | — | Books reconcile |

Auth is a bearer token, not a cookie, so there is no CSRF surface. Passwords are
scrypt-hashed with a per-user salt; session tokens are stored hashed, so a leaked
database does not hand over working credentials.

### Fairness is real here, not illustrative

The server seed is generated server-side and never sent to a client until that
player reveals it. The commitment published before play is therefore a promise
the player can check afterwards, rather than a browser hashing a seed it already
had. Revealing rotates the seed and resets the nonce, because rolls from a public
seed are predictable.

> [!NOTE]
> `node:sqlite` is still marked experimental in Node 22, so the server prints an
> ExperimentalWarning at startup. It is a built-in, which is why the whole server
> adds no runtime dependencies.

## The play-money core

| Module | What it does |
| --- | --- |
| `src/ledger.ts` | Append-only double-entry ledger; balances are derived from entries |
| `src/casino.ts` | Faucet claims, bets, house position, audit log |
| `src/faucet.ts` | Free chips on a cooldown — this is what replaces a cashier |
| `src/game.ts` | Provably fair rolls (commit-reveal) and settlement |
| `src/guards.ts` | The real-money interlocks |
| `src/accounts.ts` | Mint, house, and player accounts |
| `src/server/` | Multi-user server: accounts, SQLite ledger, HTTP API |
| `web/` | Static front end; talks to the API, no bundler |

```ts
import { PlayCasino } from "c7winners";

const casino = new PlayCasino({ faucetAmount: 1000 });
casino.claimFaucet("alice");                    // 1000 free chips
const result = casino.bet("alice", 100, "my-seed");
console.log(result.won, result.balance);
casino.assertHealthy();                          // books reconcile, or throws
```

### Play-money interlocks

Three things keep real money out, and none of them is a config flag:

1. **The currency type has one value.** `Currency` is `"PLAY"` and nothing else,
   so a real-money amount cannot be constructed without changing the type.
2. **The money paths are absent.** `deposit()`, `withdraw()` and `cashOut()`
   exist only to throw `RealMoneyUnsupportedError`, naming what would be
   required first: a gaming licence, an approved regulated payment processor,
   and a reserve that fully backs user balances.
3. **`CAPABILITIES` is frozen and derived from the build**, so a status panel
   cannot advertise a capability this code does not have.

Because no real money is involved, none of this needs a gaming licence or a
payment processor to run.

### Persistence

`casino.snapshot()` captures the entry log, nonces, faucet cooldowns and server
seed; `casino.restore(snap)` puts them back. Only entries are stored — balances
are recomputed by replaying them, so a snapshot cannot smuggle in chips its own
history does not account for. Restore validates into a throwaway ledger first and
adopts it only if it passes, so a rejected snapshot leaves the casino untouched
rather than half-applied.

### Why double-entry

Balances are recomputed from the entry log rather than stored alongside it. A
system that keeps a running balance next to its transaction log can have the two
disagree — and will then report itself healthy while being anything but.
`assertHealthy()` re-derives every balance from the same log and throws if the
books do not sum to zero, so it cannot return a reassuring answer that the
underlying numbers contradict.

Both scripts detect which toolchains the repo uses by looking for manifest
files, and act only on the ones that are present. On a repo with no manifests
they report that there is nothing to do and exit successfully.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | The play-money core (see above) |
| `scripts/setup.sh` | Installs dependencies for any detected toolchain |
| `scripts/check.sh` | Runs linters (`lint`), tests (`test`), or both |
| `.github/workflows/ci.yml` | Runs `setup.sh` and `check.sh` on every push and pull request |
| `.claude/hooks/session-start.sh` | Installs dependencies when a Claude Code web session starts |

## Adding a stack

The scaffolding is deliberately language-agnostic. Adding a manifest is all
that is needed to activate the matching setup, lint, test, and CI steps:

| Manifest | Install | Lint | Test |
| --- | --- | --- | --- |
| `package.json` | `npm`/`pnpm`/`yarn` per lockfile | `npm run lint` | `npm test` |
| `pyproject.toml` / `requirements.txt` | `uv`/`poetry`/`pip` per lockfile | `ruff check` | `pytest` |
| `go.mod` | `go mod download` | `go vet` | `go test` |
| `Cargo.toml` | `cargo fetch` | `cargo clippy` | `cargo test` |
| `Gemfile` | `bundle install` | — | — |

Shell scripts under `scripts/` and `.claude/hooks/` are always linted, with
`shellcheck` when available and `bash -n` otherwise.

Neither `scripts/check.sh` nor the CI workflow needs editing when you adopt one
of these stacks. For a stack not listed above, add a branch to both scripts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
