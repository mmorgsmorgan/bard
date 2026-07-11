#!/usr/bin/env bash
# Turnkey-free agent registration + attestation E2E against a throwaway Postgres.
set -uo pipefail
cd "$(dirname "$0")"
PORT=4125
PGPORT=5458
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
CONTAINER="bard-localreg-pg"
MASTER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

cleanup() { [ -n "${SVPID:-}" ] && kill "$SVPID" 2>/dev/null; docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

echo "▸ throwaway Postgres on :${PGPORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done

echo "▸ boot server (WALLET_PROVIDER=local, no Turnkey keys)"
# Deliberately UNSET Turnkey keys to prove the path is Turnkey-free.
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" PORT=$PORT \
  TURNKEY_API_PRIVATE_KEY= TURNKEY_API_PUBLIC_KEY= TURNKEY_ORGANIZATION_ID= \
  node server.js > /tmp/bard-localreg-server.log 2>&1 &
SVPID=$!
for i in $(seq 1 25); do curl -s "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 1; done
if ! curl -s "http://localhost:${PORT}/api/health" | grep -q '"status":"ok"'; then
  echo "✗ server failed to boot:"; tail -25 /tmp/bard-localreg-server.log; exit 2
fi

echo "▸ run registration E2E"
DATABASE_URL="$DBURL" BARD_API="http://localhost:${PORT}" node test-local-registration.mjs
RC=$?
echo "▸ server log tail:"; grep -iE "error|attest|wallet" /tmp/bard-localreg-server.log | tail -8
exit $RC
