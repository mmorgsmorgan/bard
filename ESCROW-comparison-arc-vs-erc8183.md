# BARD escrow: Circle `arc-escrow` vs. current ERC-8183 — technical assessment

**Date:** 2026-07-11
**Question:** Should BARD's on-chain escrow move to Circle's `arc-escrow` (`RefundProtocol.sol`), or stay on the ERC-8183 stack (`ERC8183.sol` + `BardJobHookV2.sol`) it already deploys?
**TL;DR:** They are **different escrow designs, not versions of the same thing.** BARD does not use arc-escrow today. Circle's contract is an unaudited **sample** with a weaker on-chain hold and no fee/reputation layer. Recommendation below: **stay on ERC-8183**, and (optionally) adopt Circle's *product framing* (Dev-Controlled Wallets / naming) without swapping the contract.

---

## 1. What each actually is

| | **Circle `arc-escrow`** | **BARD (current)** |
|---|---|---|
| Repo | `circlefin/arc-escrow` — "Workflow Escrow Refund Protocol" | in-repo `contracts/src` |
| Contract(s) | `RefundProtocol.sol` (single, EIP-712, Apache-2.0) | `ERC8183.sol` (UUPS proxy, MIT) + `BardJobHookV2.sol` hook |
| Positioning | **Sample app** — README: *"Is not intended for production use without modification"*; no tests/audit in repo, bug-bounty only | ERC-8183 "Agentic Commerce Protocol" reference impl, extended with a BARD hook; 56 forge tests green; post-audit secure redeploy (see `SECURITY-AUDIT-escrow.md`) |
| Live on Arc | (would need deploy) | proxy `0x417b10f3…`, HookV2 `0x356Cde3c…`, owned by `0xACA613…` |
| Off-chain in the sample | Next.js + Supabase + **Circle Dev-Controlled Wallets** + OpenAI validation | BARD Express backend + **Turnkey**-signed legs + Postgres |

Both: Arc testnet, USDC, "escrow with a trusted approver + refund."

---

## 2. Custody / hold strength (the load-bearing difference)

**ERC-8183 — funds locked by a state machine.**
`fund` moves USDC into the contract; the job sits in `Funded`→`Submitted`. Release happens **only** via `complete(jobId)` and **only** `msg.sender == evaluator` (server-verified: `ERC8183.sol:545`). The provider *cannot* self-withdraw. Refund paths: `reject` (evaluator) and `claimRefund` (after expiry). This is a true on-chain escrow — the contract holds custody until the evaluator acts.

**RefundProtocol — push payment with clawback-until-withdrawn.**
`pay(to, amount, refundTo)` deposits USDC and immediately credits `balances[to]`, with `releaseTimestamp = block.timestamp` (`RefundProtocol.sol:101`). Crucially, **`withdraw(paymentIDs)` enforces no timelock** (`:199-222`) — once paid, the recipient can withdraw right away. The "hold" therefore relies on:
- the off-chain app not calling `pay` until it's ready, and
- the **arbiter** clawing back via `refundByArbiter` — which only works while funds are *still in the recipient's balance* (not yet withdrawn), otherwise it draws from the arbiter's own deposited balance and books a `debt` (`:137-157`), and
- `earlyWithdrawByArbiter` — arbiter-authorized release that additionally requires the **recipient's EIP-712 signature** and can charge a fee (`:239-302`).

Net: with RefundProtocol, escrow safety is **procedural** (arbiter + sequencing), not enforced by the contract's withdraw path. For a marketplace where the provider is adversarial, that's a materially weaker guarantee than ERC-8183's evaluator-gated release. It's fine for the Circle demo (arbiter = the app), but it shifts trust onto the arbiter and the off-chain ordering.

---

## 3. Roles

- **ERC-8183:** distinct `client`, `provider`, `evaluator`, plus hook-configured `feeRecipient`/`platformTreasury`. Maps 1:1 onto BARD's creator / provider-agent / platform-verifier / fee model.
- **RefundProtocol:** one `arbiter` + payer + recipient. BARD's platform wallet would be the sole arbiter for every job. No provider/evaluator separation on-chain.

---

## 4. Fees & reputation

- **ERC-8183 + BardJobHookV2:** platform fee + evaluator fee taken in `complete` (`platformFeeBP`/`evaluatorFeeBP`), and the **hook** gates transitions on BARD reputation and enforces a consented fee cap (the M-1/M-2/L-1 fixes from the audit live here). This is where BARD-specific policy lives.
- **RefundProtocol:** one optional `feeAmount` on `earlyWithdrawByArbiter`, credited to the arbiter. No reputation hooks, no policy extension point. Any BARD fee/rep logic would move **off-chain** (into the backend) or require forking the contract.

Note: BARD bounties are currently **P2P with no platform fee** (`platformFeeUsdc: 0` in the wired route), so today the fee layer is dormant either way — but ERC-8183 keeps the on-chain option open; RefundProtocol doesn't have one beyond the arbiter fee.

---

## 5. Security posture

| | arc-escrow | ERC-8183 stack |
|---|---|---|
| Audit | none in repo; Circle bug-bounty; "not for production without modification" | internal audit done (`SECURITY-AUDIT-escrow.md`), C-1 key-leak fixed via secure redeploy, M-1/M-2/L-1 fixed in HookV2 |
| Tests | none in repo | 56 forge tests green + live E2E |
| Upgradeability | none (immutable) | UUPS proxy, owner = platform Turnkey wallet from block 0 |
| Reentrancy | direct `transfer`, no guard modifier (simple enough) | `nonReentrant` + `ReentrancyGuardTransient`, `SafeERC20` |
| Known sharp edge | `withdraw` ignores `releaseTimestamp` (§2) | force-expire admin path desyncs on-chain `expiredAt` (documented; sweep retries) |

Immutable-vs-upgradeable cuts both ways: RefundProtocol can't be rug-upgraded (the C-1 class of bug is impossible), but also can't be patched if a flaw is found. ERC-8183 is upgradeable and now correctly owned.

---

## 6. "Circle alignment"

If the goal is to be recognizably **built on Circle's Arc pattern**, note the sample's headline stack is **Circle Developer-Controlled Wallets** + Supabase + OpenAI — not just the contract. BARD instead uses **Turnkey** for signing. So even adopting `RefundProtocol` wouldn't make BARD "the Circle sample" unless you also moved custody signing to Circle DCW. The contract is the smaller part of that alignment story.

---

## 7. Migration cost, if you switched to RefundProtocol

1. **Contracts:** deploy `RefundProtocol(arbiter, usdc, name, version)` on Arc. Drop `ERC8183` + `BardJobHookV2` (lose the hook/rep/fee layer).
2. **Client rewrite:** replace `erc8183-client.js`'s 11 calldata builders (`createJob/configure/setProvider/setBudget/fund/submit/complete/reject/claimRefund/depositFee/refundFee`) with RefundProtocol's `pay/withdraw/refundByArbiter/earlyWithdrawByArbiter/updateRefundTo`.
3. **escrow-service.js rewrite:** the whole lifecycle changes shape. Notably, **release needs the provider's EIP-712 signature** (`earlyWithdrawByArbiter`) — so "release" is no longer a single platform-signed tx; the provider (agent Turnkey wallet) must sign the withdrawal terms. New coordination.
4. **Route re-map:** `fund`→`pay`; `platform-verify approve`→`earlyWithdrawByArbiter` (collect provider sig + arbiter tx); `reject`→`refundByArbiter`; expiry→(no native expiry; enforce off-chain). The `/deliver` on-chain `submit` disappears (no on-chain submit state).
5. **Re-test + re-audit** the new flow.

Rough size: comparable to the work just done to build `escrow-service.js` + wire the routes, i.e. **another full escrow build**, minus the contract authoring. The route-swap I just landed would be largely thrown away.

---

## 8. Recommendation

**Stay on ERC-8183.** It's the stronger on-chain escrow (evaluator-gated custody vs. self-withdrawable balance), it already carries BARD's fee/reputation policy via the hook, it's audited + tested + live, and the route integration is done. Circle's `arc-escrow` is a valuable **reference** for the Arc + AI-validation UX, but it's an unaudited sample with a weaker hold and no policy layer — adopting its *contract* would be a net downgrade in custody guarantees plus a second full escrow build.

**If the real goal is Circle alignment / eligibility (grant, showcase, "uses Circle escrow"):** the higher-leverage move is adopting Circle's **product** pieces — Developer-Controlled Wallets and/or the arc-escrow UX framing — while keeping ERC-8183 as the settlement contract. Worth confirming what "using this smart escrow" needs to satisfy (a checkbox for a program? a specific contract address? the UX?) before spending a build on a contract swap.

---

### Appendix — verification method
- Cloned `circlefin/arc-escrow`; read `RefundProtocol.sol` in full + README/SECURITY.
- Confirmed BARD deploys `ERC8183` + `BardJobHookV2` (`script/DeployEscrowSecure.s.sol:47-57`) and that `erc8183-client.js` targets those functions.
- `grep` for `RefundProtocol|arc-escrow` across BARD contracts + backend → **no references**.
- Read `ERC8183.complete()` (custody/release) and `RefundProtocol.withdraw/earlyWithdrawByArbiter` (custody) to compare hold strength.
