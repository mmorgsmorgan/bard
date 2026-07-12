#!/usr/bin/env bash
# FULL-LOCAL on-chain escrow + PLATFORM FEE E2E — zero Turnkey. Boots the server with
# WALLET_PROVIDER=local, ONCHAIN_ESCROW=1, and PLATFORM_FEE_BPS=250 (2.5%), then drives
# the whole lifecycle and asserts the fee lands on the platform wallet on release.
# Uses REAL Arc testnet + Circle faucet (consumes a little testnet USDC/gas).
set -uo pipefail
cd "$(dirname "$0")"

PORT=4125
PGPORT=5458
FEE_BPS=250
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
CONTAINER="bard-feeescrow-pg"
MASTER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

cleanup() { [ -n "${SVPID:-}" ] && kill "$SVPID" 2>/dev/null; docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

echo "▸ throwaway Postgres on :${PGPORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done

echo "▸ provision local platform wallet (+faucet)"
PROV_OUT="$(WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" node provision-platform-local.mjs)"
PLATFORM_ADDR="$(echo "$PROV_OUT" | grep '^PLATFORM_ADDR=' | cut -d= -f2)"
[ -z "$PLATFORM_ADDR" ] && { echo "✗ failed to provision platform wallet"; exit 2; }
echo "  PLATFORM_ADDR=$PLATFORM_ADDR"

echo "▸ boot server (WALLET_PROVIDER=local, ONCHAIN_ESCROW=1, PLATFORM_FEE_BPS=${FEE_BPS})"
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" ONCHAIN_ESCROW=1 PLATFORM_FEE_BPS=$FEE_BPS \
  SELLER_ADDRESS="$PLATFORM_ADDR" PLATFORM_OWNER_WALLET="$PLATFORM_ADDR" \
  DATABASE_URL="$DBURL" PORT=$PORT \
  node --import ./fetch-retry.mjs server.js > /tmp/bard-feeescrow-server.log 2>&1 &
SVPID=$!
for i in $(seq 1 25); do curl -s "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -s "http://localhost:${PORT}/api/health" | grep -q '"status":"ok"'; then
  echo "✗ server failed to boot:"; tail -25 /tmp/bard-feeescrow-server.log; exit 2
fi

echo "▸ run full-local fee E2E"
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" PLATFORM_FEE_BPS=$FEE_BPS \
  PLATFORM_ADDR="$PLATFORM_ADDR" BARD_API="http://localhost:${PORT}" \
  node --import ./fetch-retry.mjs test-onchain-fee-local.mjs
RC=$?
echo "▸ server on-chain log tail:"; grep -iE "on-chain|escrow|fee|error" /tmp/bard-feeescrow-server.log | tail -12
exit $RC
