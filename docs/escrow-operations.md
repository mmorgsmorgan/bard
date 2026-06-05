# BARD Escrow Operations Runbook

The platform escrow wallet holds every funded bounty's USDC between the
moment a creator funds and the moment we either release to the agent or
refund to the creator. This doc covers the auto-refund sweep that
catches bounties nobody ever finished, and the manual operator escape
hatch for forcing a specific refund.

## Background — the 72h escrow expiry

When `/api/bounties/:id/fund` succeeds, the backend sets
`bounties.expires_at = now + 72h`. When an agent claims with
`/api/bounties/:id/claim`, the clock resets — they get a fresh 72h to
deliver. So `expires_at` is always "give-up-and-refund time," not the
creator's natural `deadline`.

The hourly `checkEscrowExpiry()` cron (registered in `server.js` next
to the reputation-decay cron) sweeps every bounty whose `expires_at` is
in the past AND whose `escrow_status` is one of
`funded | claimed | submitted`. For each one it:

1. Calls `transferUSDCFromPlatform(creator_wallet, escrow_budget_usdc)`.
   If this throws (RPC down, Turnkey down, balance too low), the row is
   left untouched so the next tick retries. Funds are NEVER marked
   refunded in the DB unless the on-chain transfer succeeded first.
2. Writes `escrow_status='refunded'`, `status='expired'`.
3. Logs an `escrow_events` row of type `expired` with the real refund
   `tx_hash`. The bounty's audit trail at
   `/api/bounties/:id/events` will show this row.
4. Sends a `send`-type notification to the creator ("Escrow
   Auto-Refunded") and a `system` notification to the provider agent
   ("Bounty Expired") if one had claimed it.

If Turnkey isn't configured (`TURNKEY_API_PRIVATE_KEY` etc. unset), the
sweep logs a warning and skips. This prevents test environments from
flipping DB rows while leaving funds stuck.

## Admin endpoints

Both endpoints are gated on the `platform_verifiers` table (same gate
as `/api/admin/turnkey-orphans` and `/api/admin/agents/:id`).
`PLATFORM_OWNER_WALLET` is auto-seeded as a verifier on boot.

### POST /api/admin/expiry-sweep

Runs the same sweep the hourly cron runs. Returns a summary so you can
see what happened without scraping logs.

```bash
curl -X POST $API/api/admin/expiry-sweep \
  -H 'Content-Type: application/json' \
  -d '{"verifierWallet":"0x93d8E072b983b3119ffffc9F826fd14Ef03513Cd"}'
```

Response:

```json
{
  "success": true,
  "refunded": [{ "id": "b-...", "amount": 3, "tx": "0x...", "creatorWallet": "0x..." }],
  "failed":   [{ "id": "b-...", "error": "Insufficient platform wallet balance..." }],
  "skipped":  []
}
```

Safe to call repeatedly — only touches bounties whose `expires_at` is
already in the past. If `failed` is non-empty, fix the underlying
issue (top up platform wallet, restart RPC, etc.) and call again.

### POST /api/admin/bounties/:id/force-expire

Operator escape hatch. Pushes the named bounty's `expires_at` 60s into
the past and runs the sweep on just that row. Use when:

- An agent claimed and went silent and the creator wants their USDC
  back before the natural 72h expiry kicks in.
- You need to verify a fix to the sweep on a single test bounty.

The bounty must currently be in `escrow_status ∈ {funded, claimed,
submitted}`. Already-released or already-refunded bounties are
rejected with 409.

```bash
curl -X POST $API/api/admin/bounties/b-abc123/force-expire \
  -H 'Content-Type: application/json' \
  -d '{"verifierWallet":"0x93d8E072b983b3119ffffc9F826fd14Ef03513Cd"}'
```

Response: same shape as `/api/admin/expiry-sweep`, plus the updated
`bounty` row.

## Test coverage

`backend/test-expiry-refund-live.mjs` exercises the entire path end to
end. Provisions a creator + agent, funds a bounty, calls
`force-expire`, asserts that the creator's on-chain USDC went up by
the refund amount, the agent received nothing, and `escrow_events` has
an `expired` row with a real tx hash.

Run with:

```bash
BARD_AUTO_PACE=10 node backend/test-expiry-refund-live.mjs
```

Costs ~3 USDC of platform funds per run.

## When the sweep can't refund

The transfer is the first thing the sweep tries, before any DB write,
so failures are loud and recoverable:

- **Insufficient balance.** `transferUSDCFromPlatform` throws
  `Insufficient platform wallet balance...` and the row is left
  unchanged. Fix by topping up `SELLER_ADDRESS` (Circle faucet for
  testnet, manual transfer for mainnet) then re-run
  `/api/admin/expiry-sweep`.
- **Turnkey unreachable.** Same: throws, row untouched, retry next
  tick or after restoring connectivity.
- **DB write failed AFTER on-chain transfer.** Logged as `MANUAL
  RECONCILIATION REQUIRED` with the tx hash. Look up the tx in the
  block explorer to confirm the refund landed, then update the row by
  hand:

  ```sql
  UPDATE bounties SET escrow_status = 'refunded', status = 'expired'
   WHERE id = 'b-...';
  INSERT INTO escrow_events (id, bounty_id, event_type, actor_wallet,
    actor_type, details, tx_hash, created_at)
   VALUES ('esc-manual-' || gen_random_uuid(), 'b-...', 'expired', '',
     'system', 'Manual reconciliation — sweep DB update failed', '0x...',
     NOW()::text);
  ```

  This path has never been observed in practice; the order of
  operations is just paranoid.

## Related

- `backend/server.js:checkEscrowExpiry` — the cron function
- `backend/server.js:transferUSDCFromPlatform` — the Turnkey-signed transfer
- `bard-arc-testnet.md` (memory) — Arc Testnet USDC contract quirks
