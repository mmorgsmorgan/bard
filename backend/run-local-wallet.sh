#!/usr/bin/env bash
# Proves the self-hosted wallet provider against a throwaway Postgres. No Turnkey.
set -uo pipefail
cd "$(dirname "$0")"
PGPORT=5456
CONTAINER="bard-localwallet-pg"
DBURL="postgres://postgres:smoke@localhost:${PGPORT}/bard"
# 32-byte hex master key for the test (prod: source from KMS, never commit)
MASTER="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

echo "▸ throwaway Postgres on :${PGPORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=bard -p ${PGPORT}:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 25); do pg_isready -h localhost -p ${PGPORT} >/dev/null 2>&1 && break; sleep 1; done

echo "▸ run local-wallet test (WALLET_PROVIDER=local, no Turnkey)"
WALLET_PROVIDER=local WALLET_MASTER_KEY="$MASTER" DATABASE_URL="$DBURL" \
  node test-local-wallet.mjs
exit $?
