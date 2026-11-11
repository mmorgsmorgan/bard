# Checkpoint journal

## 2026-11-10 — Deployment signer setup (in progress)

The user selected public address `0xB804d506d5446b1A3BeBEfC903D84F754973C2D2` for the fresh deployment and asked how to supply signing access. Taking deployment guidance and the handoff only: record the new address, replace raw-key command examples with encrypted-keystore usage, and explain local unlock setup. No private key or password has been received, imported or read. Preserve the compromised-address guard and the existing dirty checkout. No broadcast is part of this setup step.

## 2026-11-09 — Cleanup, browser verification and contract review complete

Recovered the saved chat, verified the existing agent-only migration and finished its local validation. Removed 31 unreferenced database helpers, unreachable swarm execution/decryption and an unused quote cache. Updated CLI/default database selection to proposals. Removed obsolete standalone identity/profile/proof/record-board contracts and the old escrow deployment path; moved the old hook's lifecycle and edge tests onto V2. Preserved safety copies outside the checkout and left unrelated snapshots/presentation work intact.

The deployment script handles both distinct bootstrap and same signer/admin configurations, checks resulting authority/configuration and rejects the historically exposed test address supplied for SECURE_ADMIN. A fresh secure address is required. Full findings and residual admin/global-fee/backend-enforcement assumptions are in docs/CONTRACT-REVIEW.md.

Verified Passport, Ethos, PostgreSQL human-link races, local/hosted page transport, real MCP/HMAC human-link completion, ACL/VCR, CLI, SDK, fresh Anvil settlement and frontend production build. All 60 Foundry tests pass against the current stack. Saved scripts/check-browser.mjs; desktop/mobile UI and wallet-signing flows pass using synthetic wallets and provider fixtures. Screenshots are in previews/. The focused unused-code scan and final diff check pass.

Updated the canonical-guide pointers, AGENTS, README and operator runbooks. Railway backend configuration now requires repository-root deployment to include shared verification assets. Rewrote CURRENT.md with verified status, release inputs and unresolved custody/VCR/licensing/governance items. The disposable resume database and temporary test servers were shut down; no deployment, publication, commit, live wallet transaction or old-fund movement occurred.

## 2026-11-09 — Continued recovered chat (validation in progress)

Read the original chat and the prior local changes. Continuing the deployment regression, browser verification (including real signatures from disposable test wallets), cleanup checks and contract review. The original chat is idle. Existing human-link, CLI/SDK and frontend work is preserved. Tests use the existing disposable `bard-resume-test-20261109` container, isolated schemas and local Anvil only. Review and refresh the stale CURRENT.md and AGENTS.md before stopping.

## 2026-11-09 — Resumed saved chat (in progress)

Recovered the user's latest scope and read the shared handoff. Taking the unfinished human-link backend, local/hosted MCP page integration and regression tests, then cleanup verification, frontend reference review and contract review. Preserve the large existing dirty tree and historical snapshots. The existing human-link/passport modules and browser assets are present but not wired into the server or schema. CURRENT.md predates substantial cleanup and will be rewritten with verified state before stopping. No shared database, production wallet, deployment or package publication is used for local verification.

## 2026-11-08 — Frontend reference and human-link continuation (in progress)

Read the handoff and verified the existing cleanup/vouch-removal edits. Frontend baseline builds. Taking the active frontend, human verification API/MCP/browser flow, cleanup verification and subsequent contract review. User supplied a white/blue reference: large black and pale-blue typography, fine borders, dotted landscape, compact navigation. Keep the public marketplace sign-in-free and Binance Coming soon.

User supplied SECURE_ADMIN `0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8`; checksum validated. This is a public deployment input, not permission to move old funds. Review contracts for redundancy/improvements after the UI and verification work. No deployment yet.

## 2026-11-08 — Additional user decisions

Remove vouching entirely (including API/MCP/SDK, contract source, and product documentation). Binance still stays Coming soon. User also requested human ownership linking through a choice of Ethos, Human Passport, or both: a local wallet-connect/signing page opened via the agent's MCP when supported, and a Bard-hosted page fallback when the device cannot host one. Verify official Passport semantics before implementing. Keep cryptographic wallet ownership proofs separate from provider verification; do not invent a binary Passport verification from arbitrary stamp counts.

## 2026-11-08 — Cleanup requested (in progress)

User changed the active task to reading the code and removing redundant/unneeded code and files. Stop feature development. Preserve the current agent-only behavior and the retained, disabled Binance integration. Establish a test baseline, remove unreachable legacy code and obsolete duplicate files incrementally, prune unused dependencies, then update the handoff. Signed-fee changes from the interrupted continuation are present; verify them as part of the baseline and do not erase them.

## 2026-11-07 — Signed settlement continuation (in progress)

Read the shared handoff and verified the heavily dirty checkout. Taking the agreement/fee binding and related settlement regression tests, then updating documentation and this checkpoint. Binance remains unavailable by user instruction. Evaluated the local signer proposal: replacing backend custody still requires a selected signer/recovery architecture and prepare/sign/submit APIs; no MPC implementation is assumed. No live wallets or deployed databases will be used for verification.

## 2026-11-05 — Codex

Implemented and tested the initial agent-only managed-wallet migration, ACL signatures, VCR reservations, Ethos owner proofs and local-chain payout. See CURRENT.md.

Latest user request explores PC-local custody, 2-of-3 MPC, private installation binding and Binance Arc support. Inspected current custody, checked official sources and recorded WALLET-DESIGN.md. No user-PC/MPC implementation or custody migration occurred.

Created shared handoff and standing AGENTS continuation instructions. Next agent should first evaluate local signer architecture and its effects on managed-only endpoints, then address CURRENT.md's unfinished items.

No live deployment, wallet pairing, old-job migration or old-fund movement occurred.

Verified all five handoff files and AGENTS continuation instructions. Stopped and removed the disposable PostgreSQL test container. No temporary test database remains running from this task.

## 2026-11-05 — Binance availability gate

Taking the Binance CLI entry point, homepage label and docs. User requested Coming soon with access disabled while retaining the implementation.

Completed the Binance availability gate. All six CLI invocations (bare command, connect, verify, status, addresses, chains) returned Coming soon with exit code 1; a fake baw executable was never invoked. Frontend production build passed. Code retained behind a hard-coded false availability flag. No deployment occurred.

## 2026-11-10 — Deployment signing guidance ready

Recorded the user's replacement deployer/admin in CURRENT.md and DECISIONS.md and updated the README, AGENTS guide and dated contract review to point to the current signing checkpoint. Changed only the deployment script's usage comment to show encrypted-keystore simulation with file-path arguments. Contract behavior and the compromised-address rejection are unchanged.

Verified the address checksum and installed Foundry help: interactive keystore import and Forge keystore/password-file signing are supported. Forge does not list the browser-wallet flag exposed by Cast. Read back the changed guidance and ran the focused `git diff --check` successfully. The earlier 60-test contract result remains the last runtime validation; no tests were rerun for documentation-only edits.

The user must complete the recommended import and hidden local password-file setup in their own Ubuntu/WSL terminal. No secret was received, imported, read or written by this continuation. No signer-control or funding check, simulation, broadcast, commit or publication has occurred. Next: after the user confirms setup, derive and match the public address through Foundry, confirm Arc Testnet and native USDC funding, and simulate the fresh deployment. The signing recommendation has not yet been confirmed accepted or completed.

## 2026-11-10 — User completed keystore import (in progress)

The user reports successful interactive import of `bard-deployer`, with the selected public address. Metadata-only checks confirm the encrypted keystore exists with mode 0644; the unlock-password file is absent. Taking keystore permission hardening and the handoff checkpoint. No secret contents are being read or printed. Public RPC reads confirm chain 5042002 and a native balance of 43.582790449716185482 testnet USDC for the selected wallet. Restrict the encrypted keystore to mode 0600, then record that local password-file setup is the remaining signing step. No transaction or simulation has run.

## 2026-11-10 — Imported keystore checkpoint saved

Restricted the encrypted keystore to mode 0600 and verified the resulting metadata. The password file remains absent. Updated CURRENT.md and DECISIONS.md with the user's completed import and public chain/balance checks. No key or password contents were read, and no contract/runtime source changed. No tests, simulation, transaction, commit or publication ran in this step. Next: the user completes the hidden password-file prompt in their own terminal; then Foundry can derive the public signer address and run the deployment simulation. No repeat import is needed.

## 2026-11-10 — Deployment preparation with the configured signer (in progress)

The user confirmed local password-file setup is ready. Metadata checks confirm both the encrypted keystore and password file exist with mode 0600. Taking signer verification, Arc Testnet deployment simulation, transaction review and the resulting deployment records. Pass only file paths to Foundry; never print or inspect secret contents. Preserve the existing contract code and compromised-address guard. Verify the selected address, chain, nonce, balance, ownership, allowlists and zero core fees before any broadcast. Preserve unrelated checkout changes and existing deployments.

## 2026-11-10 — Deployment simulation and transaction review passed

Foundry unlocked the keystore using its password-file path and derived the exact selected public address. Arc RPC confirms chain 5042002, matching latest/pending nonce 119 and 43.582790449716185482 native testnet USDC. The payment-token interface reports USDC with 6 decimals.

The secure deployment simulation passed every role, ownership, treasury, allowlist and zero-core-fee postcondition. Reviewed the unsigned manifest: five sequential transactions at nonces 119–123; three creations and exactly the intended USDC/hook allowlist calls; zero native value transferred; expected constructor arguments and selected admin. Estimated gas budget is 0.2790738825 testnet USDC (Forge generically labels the native unit ETH). Predicted implementation `0x7DAE3eD8e9d99E95E20e11634EAE5d3Ba073D18D`, proxy `0x680e73Ff53981629b8B814cE9A69AD1347867606`, hook `0x097eF956B18E20A8E9b509791c2a430b2750f32b`. These are predictions until confirmed receipts exist.

Proceeding with the requested fresh contract deployment using sequential confirmations (`--slow`). Preserve the generated transaction/receipt manifest and verify live configuration afterward. No backend, database or frontend deployment is part of this transaction batch. The Foundry cache is ignored by Git; public broadcast manifests are not ignored at the root, so stage future changes explicitly.

## 2026-11-10 — Fresh contracts deployed and source-verified

The five reviewed transactions were broadcast sequentially and all succeeded on Arc Testnet: nonces 119–123, blocks 71616767–71616784. The deployed addresses match the simulation: implementation `0x7DAE3eD8e9d99E95E20e11634EAE5d3Ba073D18D`, proxy `0x680e73Ff53981629b8B814cE9A69AD1347867606`, hook `0x097eF956B18E20A8E9b509791c2a430b2750f32b`. Actual gas cost was 0.11481755625 testnet USDC; the remaining native balance was 43.467972893466185482.

Verified every receipt against the reviewed sender, input, nonce, destination, chain and zero transferred value. All 20 live state/code/balance checks passed, including implementation linkage, both selected admin roles, exclusion of the exposed wallet, hook ownership, treasury, allowlists, zero global fees and unpaused state. Source verification is confirmed for all three contracts using the canonical explorer address API at `explorer.testnet.arc.io`. Proxy verification required an explicit source submission because the legacy API initially treated the verified implementation as a verified proxy; queued status checks were rate-limited, but the address API confirms the proxy's own source is verified.

Saved public evidence in `contracts/deployments/arc-testnet-2026-11-10.json` and `agent-handoff/DEPLOYMENT-2026-11-10.md`; updated CURRENT, DECISIONS, AGENTS, README and the dated contract review. Runtime source was unchanged during deployment. The prior 60-test baseline was followed by a successful fork simulation, exact transaction/receipt review, live reads and source verification. No private key or password contents were exposed to the model. No backend/frontend rollout, database migration, commit, package publication or old-escrow fund movement occurred. Next: configure the fresh database and service/evaluator/provider inputs and use the recorded contract addresses for the application rollout.

Final validation: `git diff --check` passed; the saved JSON manifest parses and matches the verified deployment evidence; no stale missing-password or undeployed-contract statements remain in the active handoff and setup documents. The public manifest points to the timestamped broadcast record `run-1794267554212.json`, so a future `run-latest.json` cannot replace this evidence. The proxy verification watcher exited after exhausting rate-limited legacy status polls, but the canonical address API independently confirms all three contracts have `is_verified: true`. All deployment and verification processes have finished.

## 2026-11-10 — User requested a running project preview (in progress)

Starting the public frontend with an isolated new local PostgreSQL database, fresh preview-only service credentials and the newly deployed public contract addresses. Keep browsing sign-in-free. Inspect backend startup before launching because it starts workers; do not load existing backend environment files, old jobs or the deployment keystore. Preserve unrelated running services and checkout changes. Verify the homepage, agent directory and bounty pages, then leave the preview running with its access URL and restart details in the handoff.

## 2026-11-10 — Public project preview running

Launched `https://answer-prairie-letters-hire.trycloudflare.com` and `http://localhost:3000` using `scripts/launch-preview.mjs`. The launcher creates a dedicated PostgreSQL container/volume on 55440 and fresh mode-0600 private runtime credentials, then starts the API on 4000, MCP on 4100 and Next on 3000. It supplies an explicit environment without existing backend dotenv files or the deployment keystore. The new public contract addresses and selected public seller/platform owner are configured; evaluator signing and Passport/VCR configuration remain pending. The database starts with no agents or bounties and no imported old records.

Added optional same-origin preview routing for API, MCP, uploads and human-link assets/page, with a private API origin for server-rendered marketplace pages. The public MCP URL is shown correctly. Downloaded the official Cloudflare Linux amd64 tunnel binary to /tmp. Other running services and the previous test database were preserved.

Public HTTP checks passed for home, agents, bounties, health, both list APIs and hosted human-link page/assets. MCP initialization succeeded. A temporary Chromium check passed desktop browsing of all three main pages and a 390px homepage check with no page errors or horizontal overflow. Reviewed and saved desktop/mobile screenshots in `agent-handoff/previews/running-preview-*.png`. The browser assertion was corrected to normalize visual line breaks; application text was unchanged. A first launcher attempt exposed Docker's lowercase missing-container message, which was handled before the successful launch. Focused `git diff --check` passed.

The preview remains running under launcher PID 1395509; current child PIDs, public URL and start time are saved in `/home/chief/.config/bard/preview-20261110-state.json`. Updated CURRENT, DECISIONS, AGENTS and README with startup/operating details and the remaining permanent-hosting inputs. No new chain transactions, database migration from old state, package publication or commit occurred. Keep the preview available for the user's review.

## 2026-11-10 — Persistent animated particle background (in progress)

Taking `frontend/src/components/AgentLandscape.tsx`, the shared root layout, homepage wave placement and related background CSS. The user requested the existing blue dotted landscape as a fixed, viewport-wide, continuously animated background behind every section, with unchanged content/layout and working interactions. Preserve the active sign-in-free preview and unrelated edits. Capture safety copies and baseline element geometry before implementation. Use a lightweight particle renderer, responsive resolution limits, reduced-motion support and hidden-tab suspension. Verify idle animation, scrolling, route persistence, desktop/tablet/mobile layouts, fallback rendering and content readability in Chromium; record results and update CURRENT when complete. No service restart, contract action or credential access is needed.

## 2026-11-10 — Particle background continuation resumed

Verified that the saved renderer is still the original static canvas. The previous /tmp artifacts and preview processes are no longer present, and the dedicated preview database is stopped. Continuing only the requested background work. Restore the existing isolated preview with its launcher, keep new safety copies and layout measurements under `/home/chief/.local/share/bard-wave-20261110/`, and verify the animation in the browser. Preserve all unrelated checkout changes, page content and layout. No contract or wallet operation is involved.

## 2026-11-10 — Fixed animated particle background completed

Moved `AgentLandscape` from the hero into the shared root layout and added a fixed viewport layer below the content with pointer events disabled. Added a lightweight WebGL renderer using a single static point buffer and one draw call per frame; time-based ridges, bending, ripples and swells preserve the original blue square-particle aesthetic. Added a 30fps Canvas fallback for unavailable/lost WebGL, bounded resolution and particle counts, hidden-tab/reduced-motion suspension and complete resource cleanup. Adjusted only background transparency to retain text/card readability. No page content, layout, dependencies, backend or contract code changed in this work.

Restored the existing isolated preview after confirming its old processes and /tmp files were gone. The new public URL is `https://stack-chocolate-close-musicians.trycloudflare.com`; localhost remains port 3000. Reused only the dedicated preview database and private preview configuration through the existing launcher. No signing credential contents were read and no transaction was made. Preview processes are intentionally left running and current IDs are recorded in CURRENT.md and the private metadata file.

Verification passed: exact baseline geometry at four viewport sizes; fixed positioning and identical paused background pixels across scroll; real pixel changes without scroll; correct stacking and pointer behavior; copy endpoint and page navigation; the same canvas across routes; reduced-motion and hidden/visible handling; WebGL loss recovery; Canvas fallback animation and high-DPI resize. Chromium observed 60fps for the desktop WebGL scene and 30fps for Canvas, with no page errors. These are headless-browser measurements, not physical-device performance claims. A one-pixel mobile assertion in the first attempt came from comparing different device pixel ratios and was resolved by matching baseline settings without changing product layout. The isolated production build, lint/type validation and focused whitespace checks passed. The updated public homepage returned HTTP 200.

Saved originals, baseline measurements, screenshots, browser/build scripts and results under `/home/chief/.local/share/bard-wave-20261110/`; reviewed desktop, tablet and mobile hero/scrolled/connect screenshots. Updated CURRENT.md and DECISIONS.md. The earlier dirty checkout and unrelated work remain intact. No commit, package publication or permanent application deployment occurred. Next: keep the updated preview available for user review; the requested background work is finished.

## 2026-11-10 — Agent skill cleanup (in progress)

The user requested fixing Bard's skills and removing redundant content. Taking the canonical agent guide, repository/CLI/MCP skill entrypoints, skill discovery/loading text and the CLI guide-access packaging gap. Keep one maintained workflow and preserve authentication. Retain signed proposal checks, funding checks, retry handling and human-link boundaries. Keep disabled features disabled. Check installed-package paths before removing wrappers or references. Preserve the completed wave and running preview; use isolated local checks for skill delivery and CLI behavior. No package publication, contract or wallet action is part of this cleanup.

## 2026-11-10 — Agent skill cleanup completed

Shortened `shared/mcp/skill.md` from 1,049 to 624 words by removing repeated tool lists, CLI/SDK/setup examples and deployment narration. Preserved the agent-only proposal workflow, funding/signature/recovery rules, VCR reservations, backend wallet custody and human-link distinctions. Kept one maintained guide and transport-specific entrypoints with working installed-package access.

Added `bard skill` for fetching the selected MCP server's guide before authentication and included `cli/SKILL.md` in package contents. Only this public guide bypasses the CLI token precheck; other actions still require authentication. Empty guide responses fail clearly. Removed duplicate CLI help examples and repository-only links from installed-client guidance. MCP now loads only its bundled canonical file instead of silently falling back to pointer documents; compacted startup/tool/resource/prompt descriptions and removed redundant skill-response metadata while retaining the content field and resource URI.

Validation passed: existing CLI backend-recovery, network-retry, proposal and delivery tests; new CLI unauthenticated/saved-configuration guide access, mutation-auth exclusion and empty-result checks; MCP tool/resource/prompt consistency; isolated-package missing/empty guide behavior; both skill entrypoint metadata validators; dry-run package contents for CLI/core/stdio MCP; focused whitespace review. All requests used local fixtures and no package was published. Originals, logs and `summary.json` are under `/home/chief/.local/share/bard-skill-20261110/`.

Updated CURRENT.md. The running frontend and completed particle wave were preserved. The existing MCP process retains its previously loaded guide until a normal restart/redeploy, and published packages were not changed. No credentials, wallet operations, live transactions, backend schema changes, service restart, commit or deployment were involved. Requested source cleanup is complete; release/service refresh remains separate from this local task.

## 2026-11-10 — Hosting recommendation and GitHub push (in progress)

The user requested the best hosting setup and a GitHub push. Taking a reviewed application snapshot for the existing `mmorgsmorgan/bard` repository and a concrete deployment recommendation. Include the completed agent-only cleanup, human-link workflow, verified contracts, particle background and skill fixes needed for a coherent checkout. Check the candidate commit for local credentials, generated data and required files; preserve unrelated presentation edits and historical local snapshots. Push a reviewable branch without force-pushing existing history. The current recommendation is Vercel for Next.js and Railway for the persistent API/MCP services, a fresh PostgreSQL database and durable upload storage. Do not provision paid hosting or redeploy contracts as part of answering the hosting question.

## 2026-11-10 — GitHub preparation resumed

Recovered the interrupted session at the user's request. Node 24, Railpack and Vercel configuration edits are present, but no branch, commit or push exists yet. Preparing and validating an isolated application snapshot while preserving the original checkout and unrelated presentation changes. Check the exact candidate for secrets, replace the unlicensed copied ACL serialization helpers with a licensed dependency while retaining the signing format, and verify Node 24 installation, build and isolated tests. The former preview processes are no longer listening; retain its existing database and restore the preview after runtime verification. No new hosting resources, package publication or contract transactions are part of this continuation.

## 2026-11-10 — Additional unused-code cleanup requested

The user explicitly requested removal of code that is not needed while the GitHub work continues. Removed obsolete first-come and human-profile scripts/tests, the old SQLite cleanup and Turnkey reset migration, duplicate workspace lockfiles, duplicate MCP hosting configuration and a one-off image script. Removed retired human premium-payment handlers and their unused schema/helpers, unused swarm execution/configuration handlers, the falsely advertised swarm-hiring MCP tool and an unused RPC client. Keep current identity, proposal, wallet, settlement and historical accounting checks. The original versions are backed up outside the repository. Added focused regressions for retired endpoints/tool side effects and put the maintained checks under `npm test`; full candidate validation is pending.

## 2026-11-10 — Release snapshot validation completed

Prepared `codex/bard-agent-marketplace-20261110` in `/home/chief/.local/share/bard-github-20261110/checkout`. Node 24 clean installation, maintained unit/client/MCP suites, production frontend build, human-link/VCR/auth database checks, full Anvil job settlement, browser verification and all 60 contract tests passed. Fixed browser asset loading from hidden installation directories using a trusted sendFile root. The adapted ACL code was replaced with a licensed serializer and explicit compatible message schema; both distributions match fixed pre-change hashes and signing digests. Candidate secret scanning, JavaScript unused-binding checks and relative-import checks passed. Preserve the intentional response-field exclusions that the first lint pass identified; those protect delivery details and local server objects.

The old preview processes had stopped before this continuation. Restored the existing isolated preview database/services on Node 24 at `https://democrat-video-consider-div.trycloudflare.com`. Public pages, API, human-link assets and current MCP guide passed verification. Package dry runs confirmed all required CLI/MCP/SDK files. The disposable test database and temporary test servers are closed; the user preview remains running. No new contracts, hosted infrastructure or packages were deployed, and no old accounts, wallet material or jobs were imported. Source safety copies and verification artifacts remain outside the repository. The reviewed snapshot excludes the local test environment, generated output, historical editing copies and unrelated presentation changes. Permanent hosting is the next product release step; use the hosting guide and configure the remaining service/evaluator/provider inputs when the user proceeds.

## 2026-11-10 — GitHub publication completed

Committed the reviewed 197-file application snapshot as `85a5ec6f2c512d6f73083723c53f2d16554cd9c0` (`feat: prepare cleaned agent marketplace for fresh deployment`) and pushed `codex/bard-agent-marketplace-20261110` to `mmorgsmorgan/bard`. `git ls-remote` confirmed the exact commit on GitHub, and the isolated release checkout is clean and tracks its remote branch. Main was not rewritten. The original source checkout and unrelated presentation edits were preserved; the local handoff records this post-push result. All validation and the 203-file credential scan passed before the commit. Permanent Vercel/Railway hosting remains the next release step, with evaluator, provider and service configuration still required. The sign-in-free preview remains running at the URL above.

## 2026-11-10 — README rewrite (in progress)

Rewriting the root README at the user's request to describe the current agent marketplace, signed proposal workflow, human links, preview and source CLI setup, maintained checks, deployed contracts and remaining hosting inputs. Check documentation against the released source and existing validation records; keep runtime services and unrelated work intact. Publish only the README and updated continuation records to the existing release branch, using explicit paths. No application changes, runtime test reruns, package publication or deployment are needed.

## 2026-11-10 — README rewrite completed

Reorganized the root README into a practical project guide covering the public agent marketplace, signed proposals and delivery, VCR spending, human identity links, managed backend custody and disabled features. Added a clone command for the current release branch, the Node 24/Docker preview quickstart, explicit API/MCP endpoint overrides and source CLI examples for the unpublished commands. Documented database and browser test prerequisites, shallow Foundry dependency installation, the three verified Arc addresses and the remaining Vercel/Railway rollout inputs. Operational detail stays in the linked hosting and continuation guides.

Checked 17 internal link occurrences (14 unique targets), the preview heading fragment, seven command script paths, six Markdown shell blocks, the Node version, all three Foundry dependency pins and all three contract addresses against the release checkout and deployment manifest. Reviewed command syntax and source behavior without running agent authentication or wallet actions. The earlier application test results are explicitly identified as release-snapshot validation; runtime suites were not rerun for this documentation change. Publication uses the existing release branch and only README.md, CURRENT.md and JOURNAL.md. The running preview and unrelated checkout work were left intact. Next: permanent hosting and the recorded evaluator, Passport, VCR and service configuration remain separate release work.

## 2026-11-10 — Hosting variables and Vercel redeploy diagnosis (in progress)

The user requested Railway/Vercel variables and supplied a failed Vercel build from main at 19b055e with Node 20. Confirmed the remote release branch contains the Node 24 configuration and that Vercel's current official documentation supports Node 24. Preparing copyable service variables and instructions for deploying the correct branch, including the separate evaluator and identity/spending inputs. This is configuration guidance and documentation work; do not change live service settings, generate or read secrets, import old data or deploy application services.

## 2026-11-10 — Hosting variables and redeploy guidance completed

Confirmed with git ls-remote that main is 19b055e and the published README release was 39e4476. Vercel's official Node.js version page lists 26 (default), 24 and 22, and confirms package engines override dashboard settings. The failure therefore comes from deploying the old main source; use the existing release branch, frontend root, Node 24 and workspace install/build commands. No Node 26 migration is needed to resolve this report.

Expanded HOSTING.md with five copyable variable blocks for the Railway API, Passport, VCR, Railway MCP and Vercel. Included the verified Arc addresses, selected operator, separate managed evaluator requirement, fresh database reference, persistent wallet key/uploads and shared MCP secret. Clarified that an empty VCR map blocks spending and that frontend variables are public. Repaired the escrow runbook's README section link after the README rewrite. Checked all 26 documented variable names against source/examples, the deployment addresses, six internal links and Markdown whitespace. Runtime code and test baselines are unchanged; no application suites were rerun. Provider CLIs were unavailable on the current shell PATH, so live environment configuration and service domains were not inspected or changed. The preview, credentials and existing data were untouched. Publish the documentation on the same release branch; permanent hosting and its remaining inputs are still pending.

## 2026-11-11 — Resuming authorized policy implementation and hosting rollout

The user accepted automatic bounded VCR enrollment and authorized rollout to the mellow-gratitude Railway project and the existing Bard Vercel project. Prior infrastructure and private inputs are recorded in the original checkout and outside-repository deployment state. The prior session is unloaded. Review and finish its existing registry/verifier, concurrent provisioning, send retries, sponsor limits, client changes and tests in this release checkout, retaining authentication, ownership, signed agreements and reservations. Back up the unfinished code outside Git before edits; validate using a disposable local database and chain before deployment. Preserve original data, unrelated work and the deployed Arc contracts. Record tested behavior, live service status and remaining limits before stopping.

## 2026-11-11 — Managed policy implementation validated; rollout in progress

Finished the existing automatic registry implementation and restricted verifier role, retained fail-closed authorization and own-wallet checks, separated query and operation pools, and made platform provisioning idempotent. Direct sends retain one stable payment ID, exact request context and broadcast status. Revocation persists through automatic enrollment; operator activation increments the policy version without resetting today's reservations. Cross-day prepared platform retries reserve current-day allowance. Updated maintained MCP schemas/guide, client deployment defaults, environment examples and policy/hosting documentation.

Maintained npm suites, the Next.js production build and all 60 Foundry tests passed. Isolated PostgreSQL checks passed enrollment, secret-bound/replay-resistant decisions, wallet creation races, revocation/broadcast ordering, independent and aggregate budgets, cross-day retries and restricted-role access. The fresh Anvil API test confirms one transfer for 12 concurrent retries, one decryptable platform wallet for four provisioning calls, changed-term/cross-agent/revocation denial, signed-fee partial funding recovery and one-time payout. Credential scanning and git whitespace checks are clean. Safety copies and logs are outside the repository. Provider authentication and the intended project IDs remain valid. Continue the authorized fresh-database Railway API/MCP/private-verifier and public Vercel rollout; persist live status and remaining inputs before stopping.
