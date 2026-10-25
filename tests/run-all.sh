#!/usr/bin/env bash
# Fresh database -> build -> local server -> API tests -> 4-phone browser test.
set -e
cd "$(dirname "$0")/.."
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -q -c "drop schema public cascade; create schema public;" 2>/dev/null
npx vite build >/dev/null
node tests/local-server.mjs > /tmp/fgn-server.log 2>&1 & SERVER=$!
trap "kill $SERVER" EXIT
sleep 1
node tests/api-flow.mjs
PW_PATH=${PW_PATH:-$(npm root -g)/playwright} node tests/e2e.mjs
