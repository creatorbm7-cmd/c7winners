#!/usr/bin/env bash
# Run this repo's linters and tests.
#
# Usage:
#   scripts/check.sh          # lint, then test
#   scripts/check.sh lint     # linters only
#   scripts/check.sh test     # tests only
#
# Like scripts/setup.sh, this detects toolchains rather than hardcoding one.
# A check that is not configured is skipped, not failed, so the script stays
# green on a repo that has not adopted that toolchain yet.
set -euo pipefail

cd "$(dirname "$0")/.."

target="${1:-all}"
ran_any=0

note() { printf '==> %s\n' "$*"; }
skip() { printf '    (skipped: %s)\n' "$*"; }

lint() {
  if [ -f package.json ]; then
    ran_any=1
    note "npm run lint"
    npm run lint --if-present
  fi

  if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
    if command -v ruff >/dev/null 2>&1; then
      ran_any=1
      note "ruff check"
      ruff check .
    else
      skip "ruff not installed"
    fi
  fi

  if [ -f go.mod ]; then
    ran_any=1
    note "go vet"
    go vet ./...
  fi

  if [ -f Cargo.toml ]; then
    ran_any=1
    note "cargo clippy"
    cargo clippy --all-targets -- -D warnings
  fi

  # Always available: our own shell scripts.
  local shell_files
  shell_files=$(find scripts .claude/hooks -name '*.sh' -type f 2>/dev/null | sort || true)
  if [ -n "$shell_files" ]; then
    ran_any=1
    if command -v shellcheck >/dev/null 2>&1; then
      note "shellcheck"
      # shellcheck disable=SC2086
      shellcheck $shell_files
    else
      note "bash -n (shellcheck not installed)"
      local f
      for f in $shell_files; do
        bash -n "$f"
      done
    fi
  fi
}

test_all() {
  if [ -f package.json ]; then
    ran_any=1
    note "npm test"
    npm test --if-present
  fi

  if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
    if command -v pytest >/dev/null 2>&1; then
      ran_any=1
      note "pytest"
      pytest
    elif python3 -c 'import pytest' >/dev/null 2>&1; then
      ran_any=1
      note "python -m pytest"
      python3 -m pytest
    else
      skip "pytest not installed"
    fi
  fi

  if [ -f go.mod ]; then
    ran_any=1
    note "go test"
    go test ./...
  fi

  if [ -f Cargo.toml ]; then
    ran_any=1
    note "cargo test"
    cargo test
  fi
}

case "$target" in
  lint) lint ;;
  test) test_all ;;
  all)  lint; test_all ;;
  *)    echo "usage: $0 [lint|test]" >&2; exit 2 ;;
esac

if [ "$ran_any" -eq 0 ]; then
  note "No checks configured for '$target' yet."
fi
