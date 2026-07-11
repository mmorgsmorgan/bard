#!/usr/bin/env bash
# Boots server with ONCHAIN_ESCROW=1 against a throwaway Postgres, runs the
# route-level on-chain escrow E2E, then tears everything down.
# Uses REAL Turnkey org + Arc testnet contracts (consumes a little testnet USDC/gas).
set -uo pipefail
cd "$(dirname "$0")"

PLATFORM="0xACA613aF220d24Dd8554dF1888c34638A5f8EFBf"
PORT=4123
PGPORT=5455
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
CONTAINER="bard-routetest-pg"

cleanup() {
  [ -n "${SVPID:-}" ] && kill "$SVPID" 2>/dev/null
  docker rm -f "$CONTAINER" >/dev/null 2>&1
}
trap cleanup EXIT

echo "▸ throwaway Postgres on :${PGPORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done

echo "▸ boot server (ONCHAIN_ESCROW=1, SELLER=$PLATFORM)"
DATABASE_URL="$DBURL" ONCHAIN_ESCROW=1 SELLER_ADDRESS="$PLATFORM" PLATFORM_OWNER_WALLET="$PLATFORM" PORT=$PORT \
  node --import ./fetch-retry.mjs server.js > /tmp/bard-routetest-server.log 2>&1 &
SVPID=$!
for i in $(seq 1 25); do curl -s "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -s "http://localhost:${PORT}/api/health" | grep -q '"status":"ok"'; then
  echo "✗ server failed to boot:"; tail -20 /tmp/bard-routetest-server.log; exit 2
fi

echo "▸ run route-level E2E"
DATABASE_URL="$DBURL" BARD_API="http://localhost:${PORT}" \
  node --import ./fetch-retry.mjs test-onchain-routes-live.mjs
RC=$?

echo "▸ server log tail (on-chain lines):"
grep -iE "on-chain|escrow" /tmp/bard-routetest-server.log | tail -12
exit $RC
