# Security Audit — BARD On-Chain Escrow (ERC8183 + BardJobHook)

_Date: 2026-07-10. Scope: `contracts/src/vendor/ERC8183.sol`, `contracts/src/BardJobHook.sol`, and the live Arc-Testnet deployment. Tools: forge tests (43/43 pass), forge coverage, slither, on-chain state reads, manual review._

## Deployment under audit
- ERC8183 impl `0xa4259ef4122705c7419dd65b37743324a77bf09c` (11,933 B)
- ERC1967 proxy (AgenticCommerce) `0xa0756cf1107341a77cf77054d12e4ce9dfdcbe2b` → impl slot verified → impl above
- BardJobHook `0x12131e21998063fb06eec189d77e7bc88630def5` (4,213 B)
- USDC `0x3600…0000`, `platformFeeBP=0`, `evaluatorFeeBP=0`, `paused=false`, USDC allowlisted ✓, hook whitelisted ✓, `jobCounter=6`

---

## 🔴 CRITICAL

### C-1 — Live escrow admin/owner/treasury is a test EOA whose private key is committed to the repo
On-chain, **all** of the following are `0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8`:
- ERC8183 `DEFAULT_ADMIN_ROLE` **and** `ADMIN_ROLE` holder
- BardJobHook `owner`
- ERC8183 `platformTreasury`

That address is **W1**, whose private key `0x19f02090…380ad2c0` is hardcoded in plaintext in `backend/test-escrow-lifecycle-live.mjs` and `backend/test-escrow-refunds-live.mjs` — committed to git and pushed to GitHub (`@chiefmmorgs`). `privateKeyToAccount(W1) == 0xA1a1…a3c8` (confirmed).

**Anyone who reads the repo controls the escrow and can:**
- `_authorizeUpgrade` (UUPS) → replace the implementation with arbitrary code → **drain every USDC held in escrow**
- `pause()` then `emergencyWithdraw(token, attacker, all)` → sweep all funds
- `setPlatformFee(10000, attackerTreasury)` → route 100% of every job's budget to the attacker
- `setHookWhitelist` / `batchDetachHook` → disable BARD's fee + min-rep protections on live jobs
- hook `transferOwnership` / `setReputationReader` → seize the hook / DoS the min-rep gate

This is a **total compromise of escrow custody** and hard-blocks the custodial→on-chain migration: real funds cannot go into contracts whose admin key is public. The impl slot still points at the legit implementation, so it has **not been exploited yet** — but the key is public, so treat as live-critical.

**Fix (recommended: redeploy).** Because the key is already public, a live role-handover can be front-run/griefed by anyone holding W1. Prefer redeploying the proxy + hook with `admin`/`owner`/`treasury` = a **secured** wallet from block zero — either the platform Turnkey wallet `0xACA613…` or (better) a multisig/Safe. If redeploy is not possible, do all of, in one shot, from W1: grant `DEFAULT_ADMIN_ROLE`+`ADMIN_ROLE` to the secure wallet, `hook.transferOwnership`, `setPlatformFee(0, secureTreasury)`, then `renounceRole` for W1 — accepting the front-run risk. Then remove W1 from tests (inject ephemeral keys via env, never commit) and rotate.

---

## 🟠 MEDIUM

### M-1 — Consented fee cap (`maxFeeBps`) is only enforced at `depositFee`, not at `fund`
`BardJobHook.depositFee` checks `platformFee / (platformFee + budget) ≤ maxFeeBps` against the budget **at deposit time**. But `ERC8183.setBudget` (provider-only) can be called repeatedly while the job is `Open`, including **after** `depositFee`. `beforeAction(SEL_FUND)` only checks that the fee was deposited — it does **not** re-check the cap. So a provider can lower the budget after deposit, pushing the real fee/earnings ratio above the client's consented cap.
- **Mitigation already present:** `fund(expectedBudget)` reverts on `BudgetMismatch`, so a front-run lowering reverts the client's fund tx, and the client explicitly passes the (lower) budget they're funding. Net severity is reduced to "final-step cap not enforced; client must knowingly fund."
- **Fix:** re-evaluate the cap inside `beforeAction(SEL_FUND)` against the current budget.

### M-2 — Deposited platform fee can be permanently stranded in the hook
If an admin calls `batchDetachHook(jobId)` (the documented emergency tool) and the job is then `complete`d, ERC8183's `afterAction` is a no-op (hook detached), the job ends in `Completed` status, and the fee sits in BardJobHook. `refundFee` only allows `Rejected(4)`/`Expired(5)`, and the hook has **no owner-withdraw** → the deposited fee is unrecoverable.
- **Fix:** add an `onlyOwner` sweep for stranded fees, or allow `refundFee`/settle when `Completed` and `!feeSettled`.

---

## 🟡 LOW / INFO

- **L-1 — Contract permits `client == evaluator`.** `createJob` forbids `client==provider` and `provider==evaluator` but not `client==evaluator`, letting a client self-evaluate and stiff a provider who already delivered. BARD mitigates by always setting `evaluator = platform verifier` off-chain; the contract does not enforce it. Keep the backend invariant; optionally enforce on-chain.
- **L-2 — Min-rep gate is inert.** `reputationReader == address(0)` on-chain, so `minRepScore` is never enforced regardless of what a job configures. Fine if intentional, but not an on-chain guarantee yet.
- **L-3 — Core fees read live at `complete` time.** `platformFeeBP`/`evaluatorFeeBP` are applied at completion, not snapshotted at fund. Both are `0` today (moot), but if ever raised, admin can change the fee applied to already-funded jobs.
- **L-4 — ERC8183 branch coverage ~13%** (BardJobHook ~100%). Core escrow revert/branch paths (admin fns, expiry/grace edges, submit-open-zero-budget) are largely untested. Add branch tests before any real-fund use.
- **Slither:** no additional true-positive high/medium. Reentrancy flags on `fund/complete/reject/setBudget/submit` are covered by `ReentrancyGuardTransient` + trusted/whitelisted hook; `arbitrary from` = `job.client` guarded by `msg.sender==client`; `arbitrary-send-eth` in `emergencyWithdraw` is `ADMIN_ROLE`+`whenPaused` (severity collapses into C-1: the admin is the problem).

---

## Bottom line
The contract **logic** is in good shape (state machine, CEI ordering, reentrancy guards, fee-on-transfer rejection, 43/43 tests green). The blocker is **operational/governance (C-1): the live contracts are owned by a leaked test key.** Fix C-1 (redeploy with a secure admin) before proceeding with the on-chain escrow migration; address M-1/M-2 in the same redeploy.

---

## ✅ RESOLUTION — secure redeploy (2026-07-10)

All findings fixed via a fresh, securely-owned redeploy + hardened hook. No funds were at risk (old contracts held 0 USDC).

**New deployment (Arc Testnet), owned by the platform Turnkey wallet `0xACA613…` from block zero:**
- ERC8183 impl `0x60311dC73A9CC24Ec66cC0921872F6e9Be08fB73`
- ERC8183 proxy (AgenticCommerce) **`0x417b10f3abB5355465e0c6B95B6Ee561e5aB42B5`**
- BardJobHookV2 **`0x356Cde3c6E0218bDfE67D3B6c04D311A510958eE`**
- Deployed via `contracts/script/DeployEscrowSecure.s.sol` (bootstrap deployer W1 granted all roles to `0xACA613` then **renounced** — verified on-chain: W1 holds no roles).

| Finding | Fix | Where |
|---|---|---|
| **C-1** leaked admin key | Fresh redeploy; admin/owner/treasury = `0xACA613`; W1 renounced (verified). | `DeployEscrowSecure.s.sol` |
| **M-1** fee cap only at deposit | Cap re-checked in `beforeAction(SEL_FUND)` against current budget. | `BardJobHookV2.sol` `_enforceFeeCap` |
| **M-2** fee stranded on hook detach | Added permissionless `settleFee(jobId)` (pays feeRecipient when Completed+unsettled). | `BardJobHookV2.sol` |
| **L-1** client == evaluator | `beforeAction(SEL_FUND)` reverts `ClientCannotBeEvaluator`. | `BardJobHookV2.sol` |
| **L-3** live core fees | Resolved by policy: core `platformFeeBP`/`evaluatorFeeBP` stay 0; all fees flow through the hook (per-job, deposited upfront). ERC8183 left unmodified/pristine. | — |
| **L-2** min-rep inert | Unchanged (intentional; `reputationReader=address(0)`). Wire an ERC-8004 reader when needed. | — |
| **L-4** low core branch coverage | New `BardJobHookV2.t.sol` (13 tests) covers the fixes + reject/expiry paths; full escrow suite **56/56 green**. | `test/BardJobHookV2.t.sol` |

**Verification:** on-chain reads confirm `0xACA613` holds DEFAULT_ADMIN+ADMIN, W1 revoked, treasury+hook-owner=`0xACA613`, USDC allowlisted, hook whitelisted, fees 0, not paused. Full lifecycle ran E2E against the new contracts (jobId 1 → Completed, agent paid, fee settled, hook/AC balances 0).

**Test-key hygiene:** W1/W2/W3 private keys removed from all 5 committed test files → now sourced from env via `backend/test-wallets.mjs` (`BARD_TEST_W1/W2/W3`). NOTE: the old keys remain in git **history** and are permanently burned — they are now unprivileged testnet actors only.

**Remaining (operational, for the migration cutover):** set `AGENTIC_COMMERCE_ADDRESS`+`BARD_JOB_HOOK_ADDRESS` on the Railway `bard` service (local `.env` already updated). Inert until `escrow-service.js` wires these contracts into the backend (Phase 1 of the on-chain migration).
