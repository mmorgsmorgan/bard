#!/usr/bin/env bash
# FULL-LOCAL on-chain escrow E2E — zero Turnkey. Boots server with WALLET_PROVIDER=local
# + a local platform wallet as SELLER_ADDRESS, then drives the whole escrow lifecycle.
# Uses REAL Arc testnet + Circle faucet (consumes a little testnet USDC/gas).
set -uo pipefail
cd "$(dirname "$0")"

PORT=4124
PGPORT=5457
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
CONTAINER="bard-localescrow-pg"
MASTER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

cleanup() { [ -n "${SVPID:-}" ] && kill "$SVPID" 2>/dev/null; docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

echo "▸ throwaway Postgres on :${PGPORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done

# The local_wallets table lives in the app DB; boot the server once briefly so initSchema
# runs, OR let provider.init() create it. The provisioner creates it on first createWallet.
echo "▸ provision local platform wallet (+faucet)"
PROV_OUT="$(WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" node provision-platform-local.mjs)"
PLATFORM_ADDR="$(echo "$PROV_OUT" | grep '^PLATFORM_ADDR=' | cut -d= -f2)"
[ -z "$PLATFORM_ADDR" ] && { echo "✗ failed to provision platform wallet"; exit 2; }
echo "  PLATFORM_ADDR=$PLATFORM_ADDR"

echo "▸ boot server (WALLET_PROVIDER=local, ONCHAIN_ESCROW=1, SELLER=local platform)"
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" ONCHAIN_ESCROW=1 \
  SELLER_ADDRESS="$PLATFORM_ADDR" PLATFORM_OWNER_WALLET="$PLATFORM_ADDR" \
  DATABASE_URL="$DBURL" PORT=$PORT \
  node --import ./fetch-retry.mjs server.js > /tmp/bard-localescrow-server.log 2>&1 &
SVPID=$!
for i in $(seq 1 25); do curl -s "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -s "http://localhost:${PORT}/api/health" | grep -q '"status":"ok"'; then
  echo "✗ server failed to boot:"; tail -25 /tmp/bard-localescrow-server.log; exit 2
fi

echo "▸ run full-local E2E"
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" \
  PLATFORM_ADDR="$PLATFORM_ADDR" BARD_API="http://localhost:${PORT}" \
  node --import ./fetch-retry.mjs test-onchain-local.mjs
RC=$?
echo "▸ server on-chain log tail:"; grep -iE "on-chain|escrow|error" /tmp/bard-localescrow-server.log | tail -12
exit $RC
