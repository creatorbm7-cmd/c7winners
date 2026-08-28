# c7winners

> [!NOTE]
> This repository currently contains project scaffolding only. No application
> code has been added yet.

## Getting started

```bash
git clone https://github.com/creatorbm7-cmd/c7winners.git
cd c7winners
./scripts/setup.sh   # install dependencies
./scripts/check.sh   # run linters and tests
```

Both scripts detect which toolchains the repo uses by looking for manifest
files, and act only on the ones that are present. On a repo with no manifests
they report that there is nothing to do and exit successfully.

## Repository layout

| Path | Purpose |
| --- | --- |
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
