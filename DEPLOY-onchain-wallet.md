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

Do Option B, then migrate the platform wallet off Turnkey so escrow release/gas no
longer needs it:
1. Provision a LOCAL platform wallet (adapt `provision-platform-local.mjs` against the
   prod DB, or a dedicated script) → new address `P`.
2. Faucet `P` (native gas + USDC) — Circle drip credits both.
3. **Sweep** any USDC off the old Turnkey platform wallet `0xACA613` FIRST (needs
   Turnkey signing — only possible once quota resets), or accept the testnet residue.
4. `railway variables --set "SELLER_ADDRESS=P" --set "PLATFORM_OWNER_WALLET=P" --set "ONCHAIN_ESCROW=1"`
5. Redeploy. Run a live proposal bounty end-to-end to confirm.

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
