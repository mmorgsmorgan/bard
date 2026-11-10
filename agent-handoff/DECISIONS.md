# Product decisions

## User instructions

- Agent-only marketplace. Remove Bard human accounts and human work flows.
- Human participation is a wallet-signed ownership link through Ethos, Human Passport, or both; see the latest scope below.
- Keep Arc settlement. Add ACL negotiation/delivery verification and VCR spending controls.
- Initially keep the current managed-wallet provider alongside Binance Agentic Wallet.
- Fresh deployment with a new database and new contracts. Do not import old jobs or accounts. No old on-chain funds have been moved or deleted.
- Latest request, 2026-11-05, explores wallets created on the user's PC, inaccessible to Bard, possible 2-of-3 MPC shares, privacy-preserving device/agent binding and clone resistance.
- Latest request requires this local handoff folder for two agents to read and maintain.
- Public website access remains sign-in-free.

## Binance release decision

2026-11-05 — The user explicitly put Binance Agentic Wallet on standby. Keep the implementation, show Coming soon, and disable all user access. Do not re-enable merely because Arc support appears; require a new release decision.

## Proposed custody direction

A local signer exposes a restricted tool interface to the user's agent. Bard stores wallet proofs, installation public keys, revocable sessions and a separate Ethos attestation. A local policy engine independently checks signing requests.

A possible 2-of-3 threshold arrangement places a share on the user's device, a share with Bard and a user-controlled recovery share. This is researched, not implemented. Choosing a reviewed MPC implementation and its recovery policy remains open.

The current backend-local provider is server-controlled. Supporting user-PC wallets requires prepare/sign/submit APIs and receipt reconciliation instead of backend-only signing. Keep this distinction explicit.

## Deployment status and remaining inputs

SECURE_ADMIN supplied 2026-11-08: `0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8` (checksum validated). **Do not deploy with this address.** The 2026-11-09 review matched it to the permanently exposed test wallet recorded in `SECURITY-AUDIT-escrow.md`. The deployment script rejects it.

2026-11-10 — The user selected replacement `0xB804d506d5446b1A3BeBEfC903D84F754973C2D2`, completed the local Foundry import/password-file setup and confirmed readiness. Foundry derived the matching address. The fresh implementation, proxy and hook were deployed on Arc Testnet after a successful simulation and review of all five transactions. Actual gas cost was 0.11481755625 testnet USDC. Both admin roles, hook ownership and treasury are verified at the selected address; all three contracts are source-verified. See [DEPLOYMENT-2026-11-10.md](DEPLOYMENT-2026-11-10.md) for addresses and receipts. This completes contract deployment, not the application rollout.

The `bard-deployer` encrypted keystore and `/home/chief/.config/bard/deployer-password` are present with mode 0600. Foundry reads them through file-path arguments; no secret contents were shown to the model. This does not establish independent custody security. Keep secrets out of chat, repository files, command arguments and tool output. The deployer has not been configured as a backend evaluator.

Fresh database/hosting configuration, funded evaluator signing and new service/provider secrets are still needed for the application rollout.
A trusted VCR endpoint/resolver and policy setup per spending agent are needed.
Binance pairing and exact Arc-chain verification are needed if Binance is used.

2026-11-10 — The user asked to launch the project for viewing. A sign-in-free public preview now runs through a temporary Cloudflare tunnel, with a dedicated new local PostgreSQL database, fresh preview service credentials and the deployed public contract addresses. The lists are initially empty. The deployment keystore is not used as a preview signer. This preview does not configure permanent hosting or the remaining evaluator/Passport/VCR inputs; current URLs and process details are in CURRENT.md.

An agent account, wallet, installation and human are separate identities. Signatures prove control, not a unique physical PC, unique model, or unique person.

## Latest scope — 2026-11-08

- Remove redundant/unneeded code and remove vouching entirely.
- Human linking offers Ethos social verification, Human Passport, or both. The agent opens a local wallet connection/signing page via MCP where supported; offer a Bard-hosted page otherwise. The agent and human choose. Keep identity evidence distinct from agent reputation and verify provider semantics.
- Match the supplied frontend reference: white, black and blue, large sans-serif type, thin borders and a blue dotted landscape.
- After these changes, review the contracts for redundancy, improvements and security issues; test changes before any deployment.

## Background behavior — 2026-11-10

The user requested the existing blue dotted wave as a continuously animated, fixed, full-viewport background behind the entire website. Content scrolls over it. Preserve the white/black/blue design, typography, content and layout; keep text readable and all interactions available. This is implemented in the shared root layout using WebGL with an animated Canvas fallback, reduced-motion support and hidden-tab suspension. Current preview and validation details are in CURRENT.md.
