# Bard project guide

Read `agent-handoff/START-HERE.md`, `CURRENT.md`, `DECISIONS.md` and `WALLET-DESIGN.md` before continuing. Read [README.md](README.md) for setup and [shared/mcp/skill.md](shared/mcp/skill.md) for the maintained agent workflow.

## Runtime and workspace

- Node `24.x` (see `.nvmrc`); npm workspaces. Install from the repository root with `npm ci`.
- `frontend/`: Next.js 15 public homepage, agents and bounties. Browsing stays sign-in-free.
- `backend/`: Express, PostgreSQL, managed signing, escrow and workers.
- `vcr-service/`: private bounded policy verifier; restricted database role and no signing keys.
- `mcp-server/`: hosted MCP transport. `mcp/`: local stdio adapter.
- `shared/mcp/`: tool definitions, canonical agent guide and human verification page.
- `cli/` and `sdk/`: agent clients.
- `contracts/`: Solidity 0.8.28, Foundry, ERC8183 and BardJobHookV2. It has nested Git metadata.
- `agent-handoff/`: continuation records and browser previews. `presentation/`: separate existing deck work.

## Product and trust boundaries

- Agent-only, proposal-only marketplace on Arc Testnet `5042002`. Human accounts, vouching and first-come claiming are retired.
- Agent bearer credentials require the authenticated MCP transport where enabled. Preserve `requireAuth`, `requireOwnAgent` and operator boundaries.
- Human-link browser capabilities are short-lived and identity-only. They never authorize agent operations, transactions or spending.
- Ethos profile linkage, explicit Ethos human verification and Passport score validity are distinct. They never increase Bard reputation or bypass work eligibility.
- Managed wallets sign on the backend. User-PC signing and MPC remain proposals; do not describe backend-local encrypted keys as user-controlled custody.
- Binance stays **Coming soon** with access disabled until the user authorizes release. Swarm execution and swaps are unavailable.
- Preserve signed task, fee, delivery, retry and VCR reservation checks when editing settlement.

## Local verification

`scripts/launch-preview.mjs` starts an isolated local database, API, MCP and frontend using fresh private runtime configuration outside the repository. Optional `--public` adds a sign-in-free tunnel. Check the running preview details in `agent-handoff/CURRENT.md` before starting or stopping services; leave the user's active preview available while editing.

```bash
npm test
npm run build --workspace frontend
forge test --root contracts
```

The following require an explicitly disposable `BARD_TEST_DATABASE_URL`:

```bash
node backend/test-human-link.mjs
node backend/test-vcr-spending.mjs
node backend/test-managed-policies.mjs
node backend/test-mcp-only-agent-api.mjs
BARD_TEST_CHAIN=1 node backend/test-fresh-agent-api.mjs
```

Never casually start `backend/server.js` using a shared or production database: schema bootstrap starts expiry, reconciliation, reputation and wallet audit workers. Use isolated data, synthetic keys and `DOTENV_CONFIG_PATH=/dev/null`. Inspect `*-live*` tests before running; they can use deployed services and funds.

## Deployment

The fresh Arc Testnet contracts were deployed and source-verified on 2026-11-10. Use [agent-handoff/DEPLOYMENT-2026-11-10.md](agent-handoff/DEPLOYMENT-2026-11-10.md) for addresses, receipts and verified configuration; continuing the application rollout does not require redeploying them. Use a new database and do not import old jobs, accounts or signing material. Read [docs/CONTRACT-REVIEW.md](docs/CONTRACT-REVIEW.md). The historical admin address ending `Ba3c8` is compromised and remains rejected by the deployment script. Working local signer setup and remaining release inputs are in `agent-handoff/CURRENT.md`.

Backend and MCP deployments need the repository root so the shared guide and verification assets are included. Use `backend/railway.json` for the backend and `railway.json` for MCP. Both use Railpack and Node 24. See [docs/HOSTING.md](docs/HOSTING.md) for the Vercel/Railway service settings. Keep Passport credentials server-only. No deployment or publication is implied by a local cleanup task.

## Coordination and hygiene

- Preserve unrelated work in this dirty checkout. Do not edit `*.pre-*`/`*.original*` snapshots or the presentation unless requested.
- Record the intended work area in `agent-handoff/JOURNAL.md`. Coordinate if another agent is actively editing it.
- Keep safety copies outside the repository. Stage requested files explicitly; do not use `git add .`.
- Confirm whether root or nested Git owns a contract change before committing.
- Before stopping, update `agent-handoff/CURRENT.md` and append a dated journal entry with changes, tests, limitations and next actions. Never put secrets or private user content in the handoff.
