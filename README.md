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
npm run serve        # build the site and serve it on localhost:8080
```

The browser front end in `web/` imports the same compiled core the tests cover,
so a player verifying a roll on the site runs exactly the code under test — there
is no second implementation to drift. See [DEPLOY.md](DEPLOY.md) to put it online.

## The play-money core

| Module | What it does |
| --- | --- |
| `src/ledger.ts` | Append-only double-entry ledger; balances are derived from entries |
| `src/casino.ts` | Faucet claims, bets, house position, audit log |
| `src/faucet.ts` | Free chips on a cooldown — this is what replaces a cashier |
| `src/game.ts` | Provably fair rolls (commit-reveal) and settlement |
| `src/guards.ts` | The real-money interlocks |
| `src/accounts.ts` | Mint, house, and player accounts |
| `web/` | Static front end; loads the core as ES modules, no bundler |

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
