#!/usr/bin/env bash
# Build the static site into dist-web/.
#
# The page loads the compiled core as plain ES modules, so there is no bundler
# here and nothing to configure: the browser imports the same files the tests
# run against.
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist-web
npx tsc                       # src/*.ts -> dist/
mkdir -p dist-web/core
cp dist/*.js dist-web/core/
rm -f dist-web/core/*.test.js dist-web/core/demo.js
cp web/index.html web/app.js dist-web/

printf '==> dist-web/ built (%s files)\n' "$(find dist-web -type f | wc -l)"
