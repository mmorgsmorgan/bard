# Deploy runbook — on-chain escrow + self-hosted wallet provider

Branch `feat/onchain-escrow-and-wallet-provider` is pushed to GitHub. `bard` service
auto-deploys from **`main`**, so nothing is live until you merge. All new behavior is
gated OFF by default — merging the code alone changes prod behavior by **zero**.

Railway CLI is logged in as `blockcelestine7@gmail.com`. Link the service first:
`railway link` → project `bard` → service `bard`.

---

## Option A — Ship code only (behavior-neutral, reversible)

```bash
cd /home/chief/bard
git checkout main && git merge --no-ff feat/onchain-escrow-and-wallet-provider
git push origin main            # Railway redeploys the bard service
```
`WALLET_PROVIDER` unset (→ turnkey) and `ONCHAIN_ESCROW` unset (→ custodial). The
capability is live but dormant. Verify: `curl https://bard-production-e88b.up.railway.app/api/health`.

## Option B — Also flip hybrid (new agents Turnkey-free)

Do Option A, then:
```bash
# Generate a STRONG 32-byte key. BACK IT UP before setting it (password manager/KMS).
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
railway variables --set "WALLET_PROVIDER=hybrid" --set "WALLET_MASTER_KEY=<hex>"
```
- New agents → local encrypted wallets. Existing Turnkey wallets keep routing to
  Turnkey (still quota-frozen until the org resets).
- ⚠️ `WALLET_MASTER_KEY` is permanent signing material. Losing it orphans every local
  wallet's funds. Never rotate it once wallets exist. (Ties to the no-destructive-
  state-loss rule.)

## Option C — Full Turnkey-free escrow (platform migration)

Prod Postgres is internal-only (no public URL), so the platform wallet is provisioned
BY the running service via a platform-verifier-gated admin endpoint (branch
`feat/admin-provision-platform-wallet` — merge it first).

1. Merge `feat/admin-provision-platform-wallet` → main (adds POST
   /api/admin/provision-platform-wallet). Do Option A + B first (code live, hybrid +
   WALLET_MASTER_KEY set, redeployed).
2. Provision the platform wallet inside the service, then capture `P`:
   ```bash
   curl -s -X POST https://bard-production-e88b.up.railway.app/api/admin/provision-platform-wallet \
     -H 'content-type: application/json' \
     -d '{"callerWallet":"0xACA613aF220d24Dd8554dF1888c34638A5f8EFBf","faucet":true}'
   # → { address: "P", ... }
   ```
   (`callerWallet` must be a platform verifier — the current PLATFORM_OWNER_WALLET is.)
3. Confirm `P` shows native gas + USDC on ArcScan (faucet credits both). Faucet again if low.
4. **Sweep** USDC off the old platform wallet `0xACA613` FIRST if you want it moved
   (needs Turnkey signing — only once quota resets), or accept the testnet residue.
5. `railway variables --service bard --set "SELLER_ADDRESS=P" --set "PLATFORM_OWNER_WALLET=P" --set "ONCHAIN_ESCROW=1"`
6. Redeploy. Register two agents, run a proposal bounty fund→deliver→approve, confirm
   on-chain release (escrow_mode='onchain', release_tx set) — all Turnkey-free.

⚠️ Repointing SELLER_ADDRESS orphans any in-flight CUSTODIAL escrows on `0xACA613`
(already unreleasable under the Turnkey freeze; testnet residue). New bounties use
on-chain escrow (custody in the contract, platform wallet only evaluates + pays gas).

---

## Verify after any option
```bash
curl -s https://bard-production-e88b.up.railway.app/api/health | jq
# db=postgres, turnkey reflects env. For B/C, register a test agent + POST /wallet and
# confirm a local wallet address comes back and a row lands in local_wallets.
```

## Rollback
- Code: revert the merge commit on main + push.
- Flags: `railway variables --set "WALLET_PROVIDER=turnkey"` (and unset ONCHAIN_ESCROW)
  — but do NOT drop WALLET_MASTER_KEY if any local wallet already holds funds.
