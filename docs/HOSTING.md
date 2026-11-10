# Hosting Bard

Use **Vercel for the Next.js website and Railway for the API, hosted MCP and PostgreSQL**. The backend runs escrow expiry, reconciliation, reputation and wallet audit workers, so it needs a persistent service. Keep one backend replica until worker coordination supports multiple instances. Public browsing and previews must remain accessible without a hosting-provider sign-in.

This guide prepares the application rollout. The [Arc Testnet contracts](../agent-handoff/DEPLOYMENT-2026-11-10.md) are already deployed and verified; use those addresses. Create a fresh database with no imported accounts, jobs or wallet keys.

## Runtime and service settings

The server workspaces and `.nvmrc` pin Node **24.x**, which is supported by both providers. Vercel no longer accepts Node 20 for new deployments. Use the repository's single root `package-lock.json` and `npm ci`.

| Service | Provider | Root directory | Configuration | Start / health |
| --- | --- | --- | --- | --- |
| Website | Vercel | `frontend` | `frontend/vercel.json`, Next.js preset, Node 24 | Managed by Vercel |
| API and workers | Railway | `/` | `/backend/railway.json`, Railpack | `node backend/server.js`, `/api/health` |
| Hosted MCP | Railway | `/` | `/railway.json`, Railpack | `node mcp-server/server.js`, `/health` |
| Database | Railway | Managed PostgreSQL service | Fresh database, retained storage and backups | Private connection from API |

For Vercel, enable **Include source files outside of the Root Directory in the Build Step**. The checked-in install command runs `npm ci --prefix ..` from `frontend`, installing the complete workspace from its lockfile. The build command is `npm run build`. Disable deployment protection for any production or preview URL intended for public sharing.

For both Railway application services, keep the root at `/` even when selecting a nested config file. Railpack reads the root Node version and lockfile. Leave Railway's assigned `PORT` available; both servers read it.

## Environment and storage

Set these in the hosting dashboards, not in Git. Each example below names a setting; real secrets belong only in the relevant service's environment.

| Service | Required configuration |
| --- | --- |
| Website | `NEXT_PUBLIC_API_URL` = public API origin; `NEXT_PUBLIC_MCP_URL` = public MCP origin **plus `/mcp`**. Set before building and redeploy after changing either. |
| API | `NODE_ENV=production`; `DATABASE_URL` referencing the fresh PostgreSQL service; independent random `JWT_SECRET`, `MCP_INTERNAL_SECRET` and `PLATFORM_OPERATOR_SECRET`; retained `WALLET_MASTER_KEY`; `WALLET_PROVIDER=local` or a fully configured provider; `MCP_ONLY_AGENT_API=true`. |
| API public URLs | `CORS_ORIGIN` = exact public website origin (comma-separated trusted origins if needed); `BARD_PUBLIC_API_URL` = public API origin; `MCP_URL` = public MCP origin. |
| API settlement | `ONCHAIN_ESCROW=true`; `AGENTIC_COMMERCE_ADDRESS` and `BARD_JOB_HOOK_ADDRESS` from the deployment record; `SELLER_ADDRESS` = configured, funded evaluator wallet; `PLATFORM_OWNER_WALLET` = intended operator wallet. |
| MCP | `NODE_ENV=production`; `BARD_API` = API origin; `MCP_INTERNAL_SECRET` identical to the API value. Set `CORS_ORIGIN` only for trusted browser origins using MCP. |

Railway variable references can supply `DATABASE_URL` from the PostgreSQL service. The API currently enables PostgreSQL TLS in production; verify connectivity with the selected database template. Never weaken production authentication to get a health check passing.

Mount an API volume at `/data` and set `UPLOADS_DIR=/data/uploads`, or configure the supported R2 variables in [backend/.env.example](../backend/.env.example). Files on the container's ordinary filesystem do not survive redeployment. Retain database backups and the wallet master key together: encrypted managed wallets in PostgreSQL depend on that key.

The local deployer's Foundry keystore is not the application's evaluator. Provision a separate evaluator through the selected managed-wallet provider and fund it with testnet gas before enabling settlement. See [escrow operations](escrow-operations.md). Configure server-only `PASSPORT_API_KEY` and `PASSPORT_SCORER_ID` for Passport, and `BARD_VCR_URL` plus approved `BARD_VCR_POLICIES` for spending. The full remaining release inputs are in [CURRENT.md](../agent-handoff/CURRENT.md).

## Rollout and verification

1. Select the reviewed GitHub revision. Create the fresh Railway PostgreSQL, API and MCP services; configure storage, variables and public domains.
2. Verify API `/api/health` and MCP `/health`. Confirm authenticated MCP can reach the API with the matching shared secret.
3. Import the frontend into Vercel, apply the settings above and deploy with the new public API/MCP URLs.
4. Set the final website origin in backend CORS. Visit `/`, `/agents` and `/bounties` in a signed-out browser. Verify the fixed animated background remains visible while scrolling and navigating.
5. Check the hosted human-link page and guide retrieval. Once evaluator and VCR configuration is ready, run a controlled testnet job through proposal, acceptance, funding, delivery and one payout. Browse-only checks do not prove settlement readiness.

Do not connect this release to an old production database. Do not automatically deploy unreviewed branches into a live database. Binance, swaps and swarm execution remain disabled.

## Provider references

- [Vercel supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Railway monorepo deployments](https://docs.railway.com/guides/monorepo)
- [Railpack Node.js detection and configuration](https://railpack.com/languages/node/)

Provider settings were checked on November 10, 2026. Hosting still requires configuration and deployment; a GitHub push alone does not publish the application.
