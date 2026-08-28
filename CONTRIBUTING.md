# Contributing to c7winners

Thanks for contributing. This repository is scaffolding-only for now, so these
guidelines are intentionally light and will grow with the codebase.

## Development setup

```bash
./scripts/setup.sh   # install dependencies for whatever stacks are present
```

## Before opening a pull request

Run the same checks CI runs:

```bash
./scripts/check.sh        # lint and test
./scripts/check.sh lint   # lint only
./scripts/check.sh test   # tests only
```

A check that is not configured is skipped rather than failed, so these stay
green until the corresponding tooling is added.

## Branches and commits

- Branch off `main`; never commit to `main` directly.
- Use short, descriptive branch names (`fix/setup-idempotency`,
  `feat/scoring-api`).
- Write commit messages in the imperative mood ("Add scoring endpoint", not
  "Added scoring endpoint"). Explain *why* in the body when the reason is not
  obvious from the diff.
- Keep each pull request focused on one change.

## Pull requests

- Fill in the pull request template.
- Make sure CI is green before requesting review.
- Rebasing or merging `main` to resolve conflicts is fine; do not force-push to
  a branch someone else is reviewing or has checked out.

## Adding a new toolchain

`scripts/setup.sh` and `scripts/check.sh` dispatch on which manifest files
exist. If you add a stack already listed in the README, nothing needs changing.
For anything else, add a branch to both scripts and, if the runner needs it, a
setup step to `.github/workflows/ci.yml`.

Shell scripts are linted with `shellcheck` in CI — please keep them clean.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
