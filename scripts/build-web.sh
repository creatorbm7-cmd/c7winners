#!/usr/bin/env bash
# Build the static site into dist-web/.
#
# The page is HTML and one script: all game logic lives on the server, so there
# is nothing to bundle and no build step beyond copying.
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist-web
mkdir -p dist-web
cp web/index.html web/app.js web/control.html web/control.js dist-web/

printf '==> dist-web/ built (%s files)\n' "$(find dist-web -type f | wc -l)"
