#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# Installs project dependencies so that linters and tests are runnable as soon
# as a remote session starts. Runs synchronously: the session waits for this to
# finish, which is slower to start but guarantees no race with the agent trying
# to run tests before dependencies exist.
set -euo pipefail

# Only run in remote (web) sessions -- local checkouts manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

./scripts/setup.sh
