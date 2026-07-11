# Scope: On-Chain Escrow Migration (custodial → ERC-8183 / BardJobHook)

## TL;DR
Moving bounty escrow from the **custodial** model (platform Turnkey wallet holds funds + signs all payouts) to **trustless on-chain** escrow. This is **much less work than it sounds** — the contracts are deployed, tested, and there's a near-complete client library. The real work is backend rewiring + a human-signing frontend flow. Not a config tweak, but not a from-scratch build either.

---

## What already exists (big head start)
- **Contracts deployed on Arc Testnet & verified live on-chain:**
  - `BardJobHook` = `0x12131E…DEf5` (4,214 bytes — real logic)
  - `AgenticCommerce` (ERC-8183) = `0xa0756c…bE2B` (131 bytes — ⚠️ suspiciously small, likely a proxy/minimal; **verify in Phase 0**)
- **Solidity tests:** `contracts/test/BardJobHook.t.sol` + `BardJobHookEdgeCases.t.sol`
- **Deploy script:** `contracts/script/DeployEscrow.s.sol` (+ broadcast record committed)
- **`backend/erc8183-client.js`** — near-complete SDK: both ABIs, a viem public client, reads (`getJob`, `getFeeMeta`, status decode), and **calldata builders for every lifecycle leg** (create, configure, setProvider, setBudget, approve, depositFee, fund, submit, complete, reject, claimRefund, refundFee). Its header already documents the migration plan.
- **`arc-memo.js`** — `withMemo()` wrapper for indexable on-chain events.

## The gap
- **`server.js` never imports the client** — the 5 escrow routes (`/fund`, `/claim`, `/deliver`, `/platform-verify`, `/cancel`) are custodial (DB `escrow_status` + `transferUSDCFromPlatform` via the platform Turnkey wallet).
- **Frontend has no on-chain escrow signing** — humans never sign approve/fund txs; the backend does it for them today.

---

## Lifecycle mapping (custodial route → on-chain calls)
| Custodial route | On-chain equivalent (client builder) | Who signs |
|---|---|---|
| `POST /fund` | `createJob` + `configureBardJob` + `setBudget` + USDC `approve` + `fund` | **creator** (human wallet OR agent Turnkey) |
| `POST /claim` (first-come) | `setProvider` | platform Turnkey (or creator) |
| `POST /deliver` | `submit` | **provider agent** Turnkey |
| `POST /platform-verify` (approve) | `complete` (releases to provider) | platform evaluator Turnkey |
| `POST /platform-verify` (reject) | `reject` → `claimRefund` | platform Turnkey / creator |
| `POST /cancel`, expiry sweep | `claimRefund` / expire | creator / platform |

## The hard parts (where the effort + risk concentrate)
1. **Signing split (the #1 complexity).** Custodial works because ONE wallet does everything. On-chain, each leg is signed by its real owner:
   - Creator funds → **agent creators** sign via backend Turnkey (easy); **human creators** must sign `approve` + `fund` in their own wallet → **new frontend flow required**.
   - Provider submit / platform complete → backend Turnkey (manageable).
2. **USDC approve UX** — funding is 2 txs (`approve` then `fund`) unless you add EIP-2612 permit. The client leaves permits to the caller.
3. **Gas** — every leg is now an on-chain tx; agents pay gas (USDC-is-gas on Arc) per action. More txs = more agent-wallet funding needed.
4. **Latency** — each leg waits for a block (~seconds) vs instant custodial DB writes; the async-state UI must reflect pending txs.
5. **DB dual-write / sync** — store on-chain `jobId` + status in the `bounties` table during the transition; reconcile on-chain events → DB (indexer or receipt polling).
6. **In-flight migration** — bounties currently custodial (funds in the platform wallet, incl. the stranded `0x127EB8` funds). Need to drain/settle them before or during cutover.
7. **Fee model** — platform fee currently kept in the platform wallet post-release; on-chain, decide if the fee is enforced in-contract (`depositFee`) or still off-chain.

---

## Phased rollout (recommended)
- **Phase 0 — verify (0.5–1 day):** confirm the `0xa0756c` ERC-8183 contract is the real/complete escrow (not a stub), check owner/config/fee params on-chain, run the Foundry tests against the deployed addresses, confirm BardJobHook is wired to it.
- **Phase 1 — backend, agent-only on-chain (3–5 days):** wire `erc8183-client` into a new `escrow-service.js`; rewrite the 5 routes to build calldata + sign the legs via Turnkey + wait receipts + **dual-write** jobId/status. Agent↔agent bounties go fully on-chain with **no frontend change** (both sides are Turnkey). Adapt the live tests.
- **Phase 2 — human funding on-chain (2–3 days):** frontend `approve`+`fund` wagmi flow with tx-status UI; read on-chain job status; handle human-creator bounties.
- **Phase 3 — cutover & hardening (2–3 days):** migrate/drain in-flight custodial bounties, flip a feature flag, deprecate `transferUSDCFromPlatform`, add reorg/failed-tx idempotency, event indexer for status sync.

## Effort estimate
- **Full robust migration:** ~**2 weeks** focused (Phases 0–3 + tests).
- **MVP (agent-only on-chain escrow, Phases 0–1):** ~**3–4 days** — this alone makes agent↔agent bounties trustless and is the highest-value slice, since agents are the main actors and it needs no frontend work.

## Risks / open questions
- Is `0xa0756c` (131 bytes) actually the full ERC-8183 escrow or a stub/proxy? Gates everything → **Phase 0 first**.
- Contract owner/admin keys — who can `configureBardJob` / set fees? Must be a wallet we control (Turnkey).
- Arc precompile quirks (CallFrom/memo) interacting with contract calls — the client wraps with `withMemo`; verify it doesn't break contract semantics.
- Decide: keep custodial as a fallback (feature-flag per bounty) or hard cutover.
