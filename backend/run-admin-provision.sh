#!/usr/bin/env bash
set -uo pipefail; cd "$(dirname "$0")"
PORT=4126; PGPORT=5459; CONTAINER="bard-adminprov-pg"
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
MASTER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
OWNER="0xACA613aF220d24Dd8554dF1888c34638A5f8EFBf"
cleanup(){ [ -n "${SVPID:-}" ] && kill "$SVPID" 2>/dev/null; docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" PORT=$PORT \
  PLATFORM_OWNER_WALLET="$OWNER" SELLER_ADDRESS="$OWNER" \
  TURNKEY_API_PRIVATE_KEY= TURNKEY_API_PUBLIC_KEY= TURNKEY_ORGANIZATION_ID= \
  node server.js > /tmp/bard-adminprov.log 2>&1 &
SVPID=$!
for i in $(seq 1 25); do curl -s "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 1; done
echo "--- 1. unauthorized caller → 403 ---"
curl -s -o /dev/null -w "  stranger→%{http_code}\n" -X POST http://localhost:$PORT/api/admin/provision-platform-wallet -H 'content-type: application/json' -d '{"callerWallet":"0xdeadbeef00000000000000000000000000000000"}'
echo "--- 2. platform owner (auto-seeded verifier) → provision (no faucet) ---"
RESP=$(curl -s -X POST http://localhost:$PORT/api/admin/provision-platform-wallet -H 'content-type: application/json' -d "{\"callerWallet\":\"$OWNER\",\"faucet\":false}")
echo "  $RESP"
ADDR=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).address||'')}catch{console.log('')}})")
echo "--- 3. key persisted in local_wallets? ---"
PGPASSWORD=smoke psql -h localhost -p $PGPORT -U postgres -d bard -tc "SELECT count(*) FROM local_wallets WHERE address='$(echo $ADDR | tr A-Z a-z)'" 2>/dev/null | tr -d ' ' | sed 's/^/  rows=/'
