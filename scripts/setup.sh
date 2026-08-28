#!/usr/bin/env bash
# Install project dependencies for whatever toolchains this repo uses.
#
# The repo is language-agnostic today, so this script detects manifests and
# installs only what is present. Adding a manifest is enough to activate the
# matching branch -- no edits to this script or to CI are required.
set -euo pipefail

cd "$(dirname "$0")/.."

ran_any=0

note() { printf '==> %s\n' "$*"; }

if [ -f package.json ]; then
  ran_any=1
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    note "Installing npm dependencies with pnpm"
    pnpm install
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    note "Installing npm dependencies with yarn"
    yarn install
  else
    note "Installing npm dependencies with npm"
    # install (not ci) so partial caches are reused and the container snapshot helps
    npm install
  fi
fi

if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  ran_any=1
  if [ -f uv.lock ] && command -v uv >/dev/null 2>&1; then
    note "Installing Python dependencies with uv"
    uv sync
  elif [ -f poetry.lock ] && command -v poetry >/dev/null 2>&1; then
    note "Installing Python dependencies with poetry"
    poetry install
  elif [ -f requirements.txt ]; then
    note "Installing Python dependencies with pip"
    python3 -m pip install --user -r requirements.txt
  else
    note "Installing Python project with pip"
    python3 -m pip install --user -e .
  fi
fi

if [ -f go.mod ]; then
  ran_any=1
  note "Downloading Go modules"
  go mod download
fi

if [ -f Cargo.toml ]; then
  ran_any=1
  note "Fetching Cargo dependencies"
  cargo fetch
fi

if [ -f Gemfile ]; then
  ran_any=1
  note "Installing Ruby gems"
  bundle install
fi

if [ "$ran_any" -eq 0 ]; then
  note "No dependency manifest found -- nothing to install."
fi
