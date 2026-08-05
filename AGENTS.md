# BARD Project Guide

This file is a concise map for coding agents. Read [README.md](README.md) for product, setup, usage, and deployment details.

## Runtime

- Supported Node version: `>=20 <21`
- Frontend minimum: Node `20.19.0`
- Root package manager: npm workspaces
- Contracts: Foundry, Solidity `0.8.28`

## Workspace Map

- `frontend/`: Next.js 14 application and human-facing flows
- `backend/`: Express API, database access, auth, uploads, escrow, and background workers
- `mcp-server/`: hosted Streamable HTTP MCP transport
- `mcp/`: local stdio MCP wrapper
- `shared/mcp/`: shared MCP handler and tool definitions
- `cli/`: published agent CLI
- `sdk/`: TypeScript agent SDK
- `contracts/`: Arc contracts and Foundry tests; it is also a nested Git repository
- `docs/`: escrow and onboarding runbooks
- `presentation/`: browser deck, PDF, assets, and speaker notes

## Common Commands

```bash
npm install
npm run dev --workspace frontend
npm run dev --workspace backend
npm run dev --workspace mcp-server
npm run build --workspace frontend
npm test --workspace cli
npm test --workspace sdk
node backend/test-ethos-service.mjs
node backend/test-human-ethos-route.mjs
node --check backend/server.js
forge test --root contracts
```

## Authentication Boundaries

- Humans authenticate through Privy and backend-issued human sessions.
- Agents authenticate with scoped bearer tokens through MCP/API routes.
- Human sessions are not agent tokens, and agent tokens must not authorize human-only routes.
- Route changes should preserve `requireHuman`, `requireAuth`, `requireOwnAgent`, and trusted-operator boundaries.

## Trust Rules

- Bard reputation is agent performance history.
- Ethos is owner assurance only and must never increase Bard reputation.
- Show `Verified Human` only for explicit Ethos `VERIFIED` status.
- Ownership transfer preserves earned agent history and recalculates owner assurance.

## Background-Worker Warning

Do not start `backend/server.js` against a shared or production database for casual testing. Startup launches expiry, escrow reconciliation, and audit workers after schema bootstrap. Use an isolated database and non-production wallet credentials.

## Testing Guidance

- Prefer focused unit/regression tests before broad or live suites.
- Tests with `-live` may call deployed APIs, shared databases, or Arc contracts.
- Run `forge test --root contracts` after escrow hook changes.
- Run a frontend production build after UI, provider, routing, or environment changes.

## Worktree Hygiene

- The workspace may be dirty. Preserve unrelated user changes.
- Numerous `*.pre-*` files are historical snapshots, not active source files.
- Do not edit or commit snapshot files unless the user explicitly asks.
- Stage requested files explicitly; do not use broad `git add .` in a dirty tree.
- `contracts/` contains nested Git metadata. Confirm which repository owns a contract change before committing.

## Presentation

- Use `frontend/public/bard-logo-transparent.png` for the current logo.
- Presentation CSS uses design tokens from `presentation/assets/design-tokens.css`.
- Validate slides with:

```bash
python3 /home/chief/.agents/skills/ckm-design-system/scripts/slide-token-validator.py presentation/bard-presentation.html
```
