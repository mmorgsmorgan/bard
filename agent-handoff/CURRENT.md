# Current checkpoint

2026-11-11, Africa/Lagos. BARD is live at **https://bard-six.vercel.app**, without a sign-in gate. Railway API/workers, MCP, private verifier and fresh PostgreSQL are deployed successfully. Automatic bounded wallet policies, a funded backend-managed evaluator, server-only Passport credentials and persistent uploads are configured. Hosted policy and desktop/mobile browser checks passed. The previous temporary preview stopped after the host restart. Updated npm packages and real human-provider verification remain separate work. No old data, signing material or funds were imported or moved.

Read [DECISIONS.md](DECISIONS.md), [WALLET-DESIGN.md](WALLET-DESIGN.md) and [the contract review](../docs/CONTRACT-REVIEW.md) before continuing. The former November 5 checklist was stale; the state below was checked against the actual checkout.

## GitHub snapshot and latest cleanup

### 2026-11-11 — Managed wallet policy rollout

Automatic policy enrollment is implemented and validated in the release checkout. The private verifier uses a restricted database role, authenticated fresh decisions, approved recipient/contract rules and versioned policy bindings. Own-agent and operator boundaries remain enforced. Wallet creation is atomic, self-revocation persists until operator reactivation, managed sends require stable payment IDs, and uncertain broadcasts retain reservations. Waiting policy operations have separate connection pools; cross-day platform retries count against the current day's budget. Sponsor and operator spending limits start at zero.

Validation passed: maintained npm suites, production Next.js build with lint/types, all 60 Foundry tests, isolated policy/role/budget tests, and the fresh local-chain API flow. Twelve simultaneous send retries transfer once; four simultaneous platform-wallet requests reuse one decryptable wallet. Tests reject changed terms, foreign agents, revoked policies, forged/stale/replayed decisions and unauthorized database access. Existing signed-fee funding recovery, delivery checks and one-time settlement remain verified. The test-only Arc memo fixture supplies the observable ERC20 transfer effect on Anvil, which lacks Arc's CallFrom precompile.

The authorized Railway project is `mellow-gratitude` (`4fe97bc9-05a4-42c7-ab32-c057e34de665`), production environment `e4939916-bc67-4573-ab55-51dd9f519e85`. Vercel uses project `prj_Bw4Gh6UMhEJH6fap1UD6An9ZWgYj`. Public services are `https://bard-api-production.up.railway.app`, `https://bard-mcp-production.up.railway.app/mcp` and `https://bard-six.vercel.app`. All Railway deployments report SUCCESS, and Vercel's reviewed application deployment is READY. The private verifier and database have no public service domains. See [the hosting record](HOSTING-2026-11-11.md) for service/deployment IDs, evidence and limits.

Vercel's production branch is now the release branch, with frontend root, Node 24 and outside-root sources verified. SSO/password protection is disabled, and frontend API/MCP URL values were read back. New Railway services rejected deprecated JSON configuration; the rollout clears that setting and uses explicit start commands and health checks. Deployment tooling and nonsecret state are under `/home/chief/.local/share/bard-deploy-20261110/`. Private inputs and the retained wallet master key remain outside Git.

The operator-only API provisioned and faucet-funded evaluator `0x25126adb8b8995bcef6e7eef1269d393961e97b8` with 20 native testnet USDC. API health confirms that seller address. `PLATFORM_OWNER_WALLET` remains the selected contract admin. Hosted MCP checks passed automatic enrollment, four concurrent calls reusing one wallet, direct-REST/foreign-agent/operator denial, durable self-revocation, revoked-send denial and versioned operator reactivation. Two unfunded test agents were removed after zero-balance checks. Chromium verified all three public pages at desktop/mobile widths and endpoint copying, without page errors or overflow.

A controlled fresh, faucet-funded hosted job completed on Arc: job `1`, bounty `bounty-1794426974186-53gs2y`, agreed payout 1 USDC. Funding retries reused the job, approval retries reused one payout, and four concurrent 0.01 USDC send retries produced one transfer. Changed send terms were rejected. See [the hosting record](HOSTING-2026-11-11.md) for receipts. These two funded release-check accounts remain for audit with dormant availability, revoked policies and revoked tokens; do not delete funded wallets. Do not redeploy the Arc contracts or use an older database.

- Published application commit: [`34e8458`](https://github.com/mmorgsmorgan/bard/commit/34e8458ed32565441c9a4c479c9dac0082d52457) on [GitHub branch `codex/bard-agent-marketplace-20261110`](https://github.com/mmorgsmorgan/bard/tree/codex/bard-agent-marketplace-20261110). The remote SHA was verified after pushing. Continue code work in `/home/chief/.local/share/bard-github-20261110/checkout`. The original `/home/chief/bard` checkout retains unrelated presentation edits and historical copies; the hosted policy implementation has not been merged into its runtime source. Only its handoff is synchronized.
- The [root README](../README.md) has been rewritten for the current release: implemented features and limits, Node 24/Docker preview setup, source CLI usage for unpublished commands, the signed work and human-link workflows, maintained checks, verified contract addresses and hosting inputs. Documentation links, command paths and version/address references were checked against the release checkout. This update changes documentation only; the application validation below remains the recorded baseline.
- The prior Vercel failure selected `main` at `19b055e` with Node 20. Production now follows the reviewed Node 24 release branch and builds successfully. [HOSTING.md](../docs/HOSTING.md) records the actual service settings and URL conventions.
- Node 24 is pinned across the application and single workspace lockfile. Railway uses repository-root services and explicit settings; Vercel builds `frontend`. Vercel follows Git pushes; Railway uploads remain a separate step.
- Removed 18 additional obsolete files: duplicate lockfiles/configuration, a one-off image script, old SQLite/reset/seeding tools, and first-come, swarm and human-profile tests. Removed retired human premium-payment handlers and their unused schema/helpers, unused swarm handlers and secret-storage code, an unused RPC client, and three unused payment packages. The legacy swarm MCP tool is no longer advertised or executable. Old swarm HTTP routes return 503 even if the old feature flag is set. Existing agent auth, wallet provisioning, spending, settlement and historical accounting checks remain.
- Replaced the adapted ACL helper source with Bard format modules using the MIT-licensed `fast-json-stable-stringify` dependency. Fixed canonical JSON, task-hash and EIP-712 digest vectors preserve signing compatibility in both backend and standalone CLI. See [AGREEMENT-FORMAT.md](../docs/AGREEMENT-FORMAT.md).
- The tracked local `backend/.env.test` is omitted from the release checkout; the user's original file remains local. No runtime secrets, dependencies, build output, editing backups or unrelated presentation changes are included in the snapshot.
- Verification passed on Node 24.22.2: clean `npm ci`, maintained `npm test` suites, Next.js production build with lint/types, human-link/VCR/MCP database checks, the complete local Anvil settlement flow, browser identity/navigation/error/retry checks, and all 60 Foundry tests with the declared library versions. Browser verification found and resolved asset serving under hidden installation directories by using an explicit trusted asset root. Public preview HTTP returned 200. The candidate credential scan and unused-binding/import checks passed.
- Verification logs, redacted scan reports, compatibility vectors, cleanup manifests and safety copies are under `/home/chief/.local/share/bard-github-20261110/`. A full-history OpenZeppelin download stalled; a shallow checkout of the same pinned commit completed. README records the absolute-root Foundry installation command.

## Local preview — stopped

- The old `democrat-video-consider-div.trycloudflare.com` tunnel and localhost services stopped after the host restart. Use **https://bard-six.vercel.app** for the current public deployment. Old PIDs in `/home/chief/.config/bard/preview-20261110-state.json` are stale.
- The `bard-preview-20261110-data` volume, private preview configuration and upload directory were preserved. Local preview credentials remain distinct from hosting credentials. Do not point the old checkout or preview at the hosted database.
- For a new isolated preview, use Node 24 and `node scripts/launch-preview.mjs` from the release checkout. Optional `--public` uses `/tmp/bard-cloudflared-linux-amd64`, obtained from Cloudflare's official GitHub release. Stop an actual running launcher before replacing it; do not stop services using old recorded PIDs.
- Historical preview screenshots remain in `previews/`. Current hosted-browser evidence and screenshots are under `/home/chief/.local/share/bard-deploy-20261110/hosted-browser/`.

## Implemented and verified

- Public Next.js 15 homepage, agent directory, bounty board and detail pages use the requested white/black/blue design with a persistent animated dotted landscape. Active routes use standard `page.tsx` files. Human account, dashboard, wallet and other legacy screens were removed. Public access has no sign-in gate.
- Backend human-account routes return 410; human-delegated credentials have no agent authority. Vouching was removed from API/MCP/CLI/SDK, the schema bootstrap and contract sources. Legacy vouch/claim entry points return 410.
- `bard_link_human` creates a 15-minute identity-only browser session. The local stdio adapter can serve/open a loopback page and returns a hosted fallback. Hosted MCP, CLI and SDK return a hosted page. The human chooses Ethos, Passport or both, connects a browser wallet and signs.
- Backend sessions store only the hash of the browser capability. Challenges bind the agent, wallet, providers, nonce, domain and expiry. Completion is atomic; reuse, another agent's challenge, wallet replacement without unlinking, invalid signatures and an unlink/completion race are rejected.
- Ethos social profile linkage is distinct from explicit Ethos `VERIFIED`. Passport checks the wallet, score, scorer threshold, passing flag and expiry. Expired saved Passport proofs no longer report a passing score. Raw Passport stamps and API keys are not returned or stored.
- Human linkage uses `human_owner_wallet` and provider assurance rows, independently of the agent signing identity. Linking/unlinking does not change agent reputation or bounty eligibility.
- New jobs and default CLI listings use proposals. Providers sign terms, clients countersign acceptance, funding binds amount/deadline/task/platform fee, and delivery binds the proposal and evidence. Fee terms survive later server fee-setting changes.
- VCR guards funding and direct USDC sends with serialized budget reservations and retry consistency. Partially funded jobs resume using the same on-chain job. Failed or uncertain broadcasts retain reservations.
- Binance remains **Coming soon**, with its implementation retained behind disabled access. Swaps are blocked; swarm execution is unavailable.
- The agent instructions are maintained in `shared/mcp/skill.md`. Repository, CLI and MCP entrypoints direct readers to that guide; installed clients retrieve it through the configured MCP service. The new `bard skill` command can read it before authentication. README, AGENTS and operator runbooks were refreshed.
- Removed 31 unused database helpers, an unreachable swarm executor/decryption path and a write-only quote cache. The focused unused-code scan reports no remaining warnings in its selected active modules.
- Removed unused legacy profile/badge/PFP/proof/agent/record-board contracts and deployment scripts. Only the current ERC8183/V2 settlement stack remains in active contract source. Old hook lifecycle/edge tests now exercise V2.
- Fixed deployment role handoff for both distinct bootstrap and same signer/admin cases. Added role/configuration postconditions and a guard against the known compromised admin address.
- Next.js traces within this repository instead of the parent home directory. Railway backend configuration now starts `node backend/server.js` from the repository root, which is required for shared human-link assets.

## Animated particle background — complete

- `AgentLandscape` now mounts once in the shared root layout, outside the hero. Its fixed full-viewport layer has `pointer-events: none` and sits below the content. The same canvas survives client navigation between the homepage, agents and bounties.
- `frontend/src/lib/particle-landscape.ts` retains the original RGB blue, two-ridge composition and tiny square particles. A static GPU buffer and one WebGL points draw per frame animate horizontal flow, bending, ripples and swells using elapsed time, independently of scrolling. No animation library or dependency was added.
- The drawing buffer is capped around 3.2 million pixels, pixel ratio is limited, and particle count is bounded. WebGL targets 60fps. The Canvas fallback uses fewer particles, batched opacity and 30fps. WebGL initialization failure or context loss switches to a fresh Canvas renderer. Reduced motion renders a still landscape; hidden tabs stop the loop. Cleanup releases observers, listeners, animation frames and GPU resources.
- Only wave placement, rendering and background surfaces changed. Section backgrounds allow the dots through; cards keep stronger white surfaces for readability. All measured positions, sizes and page heights match the original at 1440×900, 768×1024, 390×844 and 320×740 when compared at matching device pixel ratio. No horizontal overflow.
- Chromium checks passed actual pixel changes while idle, identical background pixels across scrolling with motion paused, stacking, pointer events, copy-button interaction, canvas persistence across routes, reduced-motion changes, emulated hidden/visible signals, WebGL context-loss recovery and animated Canvas fallback with high-DPI resizing. Observed 60fps for 39,100 WebGL points at 1440px and 30fps for the fallback in this headless run; this is not a physical-device GPU benchmark. No browser page errors.
- The production frontend build, including lint/type checking, passed from an isolated copy so the live preview's `.next` directory stayed available. No application code changed after that build. Public preview homepage returned HTTP 200 with the new background.
- Durable originals, baseline geometry, screenshots, browser/build scripts and `checks.json` are under `/home/chief/.local/share/bard-wave-20261110/`. In particular, `after-1440-hero.png`, `after-1440-scrolled.png`, `after-390-hero.png` and `after-390-scrolled.png` show the result. `check.mjs` repeats the focused browser checks; `build.mjs` performs the isolated build. `baseline.mjs` is archived evidence; do not rerun it over the saved originals. The first test attempt compared different pixel ratios on mobile and reported a one-pixel text-metric difference; matching the baseline browser settings resolved it without changing layout styles.

## Agent skill cleanup — complete

- Reduced the canonical guide from 1,049 to 624 words (about 40%). Removed the repeated tool catalog, duplicated CLI/SDK/setup examples and deployment notes. Kept proposal/funding/signature/retry, VCR, server custody, disabled-feature and identity-link boundaries. Use `tools/list` for live schemas and `bard help` for CLI syntax.
- The root guide remains a repository pointer. CLI/MCP skill descriptions are scoped to their workflows and no longer link to repository paths missing from installed packages. `cli/SKILL.md` is now included in the CLI package. `bard skill` fetches the guide from the selected MCP endpoint without requiring a token, validates nonempty content, and preserves the existing authentication checks for other commands. Removed duplicated bounty/human-link examples from CLI help.
- MCP loads only its bundled `skill.md`. Removed fallbacks to pointer files that could send readers back to `bard_get_skill` forever; missing or empty bundled content now fails clearly. Shortened discovery, initialization and prompt text, removed outdated platform claims and redundant response metadata, and preserved the guide's `content` field and resource URI.
- `npm test --workspace cli` passed the existing backend-recovery/network/proposal/delivery checks and the new guide-access regression. `npm test --workspace shared/mcp` passed tool/resource/prompt consistency and isolated-package missing/empty-guide checks. Both CLI/MCP skill entrypoints passed the skill-creator metadata validator. Package dry runs confirmed the CLI skill, MCP skill and canonical core guide are included. No package was published.
- Safety copies, verification scripts/logs and the word-count summary are in `/home/chief/.local/share/bard-skill-20261110/`. That guide cleanup did not change frontend, backend, contract or wallet-provider behavior. The restored Node 24 preview now loads the revised guide. Published CLI packages remain unchanged until a separate release.

## Tests completed

- `node backend/test-passport-service.mjs`: provider score/threshold/expiry/address validation, unavailable/malformed responses and private data exclusion passed.
- `node backend/test-human-link.mjs`: PostgreSQL route, capability, signature, both-provider atomicity, race, expiry, unlink and reputation checks passed.
- `node shared/mcp/test-human-link-local.mjs`: loopback Host/Origin/auth/path boundaries, browser-launch fallback, server closure and stdio local/hosted choices passed.
- `node backend/test-mcp-only-agent-api.mjs`: real hosted MCP/HMAC transport, human-link creation and wallet-signature completion, credential separation and existing negative-auth checks passed.
- `node backend/test-ethos-service.mjs`, `node backend/test-agent-agreement.mjs`, `node cli/test-agent-protocols.mjs` and `node backend/test-vcr-spending.mjs` passed.
- `BARD_TEST_CHAIN=1 node backend/test-fresh-agent-api.mjs`: local Anvil and PostgreSQL passed signed proposal/update/acceptance, config-independent fees, partial funding retry, VCR denial, evidence tampering, revisions and single payout/repeated approval.
- `npm test --workspace cli` passed after updating the listing regression to the new proposal default; explicit multi-status requests still run concurrently and retry reads without retrying mutations.
- `npm test --workspace sdk` passed including its build and human-link/proposal/delivery MCP calls.
- `npm run build --workspace frontend` passed with only the intended public routes; the repository-root tracing warning is resolved.
- `forge test --root contracts`: **60 passed**, including 256 fuzz runs for the fee cap. All lifecycle/edge cases now target V2. One compiler suggestion remains: `beforeAction` can be marked `view`.
- `scripts/check-browser.mjs` passed desktop and 320/390/768px layouts, listings/details/404/empty/error/retry, copy endpoint, reduced motion, hosted/local verification, all three provider choices, signature cancellation/retry, account switching and missing-wallet/link states. Uses actual signatures from disposable keys, real routes and PostgreSQL, with mocked identity providers.
- `git diff --check` passed. Generated Next declarations were normalized to LF.

Screenshots are in [previews/](previews/): home desktop/mobile plus human-link desktop/mobile/small. They show synthetic local fixture data, not a live verification result.

## Contract deployment — 2026-11-10

- ERC8183 implementation: `0x7DAE3eD8e9d99E95E20e11634EAE5d3Ba073D18D`.
- ERC8183 proxy / `AGENTIC_COMMERCE_ADDRESS`: `0x680e73Ff53981629b8B814cE9A69AD1347867606`.
- BardJobHookV2 / `BARD_JOB_HOOK_ADDRESS`: `0x097eF956B18E20A8E9b509791c2a430b2750f32b`.
- Deployer, both admin roles, hook owner and treasury: `0xB804d506d5446b1A3BeBEfC903D84F754973C2D2`.
- Five confirmed transactions, nonces 119–123, blocks 71616767–71616784. Actual gas cost: **0.11481755625 testnet USDC**; post-deployment balance: 43.467972893466185482 testnet USDC.
- Verified live: proxy implementation, both admin roles, old-wallet role exclusion, owner/treasury, USDC and hook allowlists, hook linkage, zero global core fees, zero optional reputation reader, unpaused state and nonempty runtime code. Every receipt matches the reviewed simulation.
- Source verification is confirmed for all three contracts at `https://explorer.testnet.arc.io`. The older ArcScan domain redirects there. The explorer recognizes the proxy's EIP-1967 implementation.

See [the deployment record](DEPLOYMENT-2026-11-10.md) and [machine-readable manifest](../contracts/deployments/arc-testnet-2026-11-10.json) for transaction hashes, source settings, checks and application environment values. Do not redeploy these contracts to continue the service rollout. No contract runtime code changed during deployment; the earlier 60-test result remains the regression baseline, followed by a successful fork simulation and live verification.

## Local test setup and cleanup

Use Node 24.22.2 at `/home/chief/.nvm/versions/node/v24.22.2/bin`. Database tests require an explicitly disposable `BARD_TEST_DATABASE_URL`; never point these at production. See README for commands and optional Playwright configuration. The browser script is saved in the repository at `scripts/check-browser.mjs`.

The disposable `bard-resume-test-20261109` and `bard-github-check-20261110` PostgreSQL containers were stopped and removed. Temporary browser/API/Next/Anvil verification servers are closed. The November 11 `bard-vcr-tests-20261111` container is stopped with its isolated data retained; it is separate from hosted PostgreSQL. The old local preview is stopped. Unrelated databases and GenLayer services were left alone.

Safety copies from this continuation are under `/tmp/bard-resume-20261109-before-final-cleanup/` and `/tmp/bard-resume-20261109-contract-cleanup/`. Earlier cleanup backups remain under `/tmp/bard-cleanup-20261108/`. Temporary directories are not durable release artifacts. Preserve the existing dirty tree, historical snapshots and unrelated presentation work; do not stage everything indiscriminately.

## Remaining release inputs and limits

1. **Contract deployment and signer setup complete.** The selected wallet holds the verified roles above. Both local signing files have mode 0600, and Foundry successfully unlocked them without exposing their contents to the model. This is not an independent custody audit. The previous `0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8` remains permanently exposed and rejected by the deployment script, and it has neither admin role in the new proxy. Never reuse it for admin, evaluator or funds.
2. Permanent hosting, fresh PostgreSQL, persistent uploads, funded evaluator, service secrets and public URLs are configured. All Railway services use repository root `/` and explicit settings. No old accounts, jobs or signing material were imported.
3. Server-only Passport key/scorer are configured, but no real consenting human Ethos/Passport claim has been established. Browser extension/mobile wallet interoperability beyond the injected test provider still needs a live check.
4. Registry VCR enrollment and revocation are live; an ENS map is unnecessary for this mode. Cross-day platform retries and budget isolation passed local tests. This profile accounts for BARD spending, not unrelated external systems.
5. User-PC signing, installation credentials and MPC are still proposals. The backend-local provider encrypts full keys with a server-held master key; the backend can sign.
6. The core proxy retains upgrade, pause, emergency-withdraw and hook-detachment powers. Global core platform/evaluator fees must stay zero to avoid reducing signed provider earnings; see CONTRACT-REVIEW.md. ACL/VCR/reputation enforcement is primarily in the backend, not trustless contract enforcement.
7. The adapted ACL helper source has been removed; Bard now uses a licensed serializer and compatible schema with fixed-vector regression checks. Backend/standalone CLI format modules must remain compatible. AXL, 0G storage and TEE inference are not integrated.
8. No broad dependency-advisory remediation or production audit is claimed by this continuation. The prior audit JSON in /tmp is historical. Review release dependencies and financial governance separately before production.
9. Binance remains disabled until a new user release decision and verified Arc support. Do not enable swarms or swaps merely because dormant endpoints exist.

## Next action

The authorized application rollout and controlled hosted escrow check are complete. The hosting records are published on the same release branch. Use the public website for review. Updated npm publication and a real consenting human-provider check are separate future tasks. Continue from the release checkout; preserve the dirty original checkout and never point its old runtime at hosted PostgreSQL.

The encrypted signer is `/home/chief/.foundry/keystores/bard-deployer`; its unlock-password file is `/home/chief/.config/bard/deployer-password`. Both are present with mode 0600 and were used successfully. Do not repeat the import or ask for secrets in chat. Pass file paths to Foundry with `--keystore` and `--password-file`; never print their contents. Local processes with access to both files can sign. These deployment credentials have not been configured as a backend evaluator.

Do not restart completed cleanup, signer setup or contract deployment, or treat the old handoff checklist as unfinished work.
