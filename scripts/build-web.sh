#!/usr/bin/env bash
# Build the static site into dist-web/.
#
# The page is HTML and one script: all game logic lives on the server, so there
# is nothing to bundle and no build step beyond copying.
set -euo pipefail

cd "$(dirname "$0")/.."

# The reels page imports the API client the repo already ships and tests, rather
# than carrying its own copy of the transport, so the compiled file has to exist.
if [ ! -f dist/client/playApi.js ]; then
  printf '==> compiling (dist/client/playApi.js is missing)\n'
  npx tsc
fi

rm -rf dist-web
mkdir -p dist-web
cp web/index.html web/app.js web/control.html web/control.js web/reels.html web/reels.js dist-web/
cp dist/client/playApi.js dist-web/playApi.js

printf '==> dist-web/ built (%s files)\n' "$(find dist-web -type f | wc -l)"
