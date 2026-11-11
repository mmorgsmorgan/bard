# Hosting Bard

Use **Vercel for the Next.js website and Railway for the API, hosted MCP, private VCR verifier and PostgreSQL**. The backend runs escrow expiry, reconciliation, reputation and wallet audit workers, so it needs a persistent service. Keep one backend replica until worker coordination supports multiple instances. Public browsing and previews must remain accessible without a hosting-provider sign-in.

This guide prepares the application rollout. The [Arc Testnet contracts](../agent-handoff/DEPLOYMENT-2026-11-10.md) are already deployed and verified; use those addresses. Create a fresh database with no imported accounts, jobs or wallet keys.

## Runtime and service settings

The server workspaces and `.nvmrc` pin Node **24.x**, which is supported by both providers. Vercel no longer accepts Node 20 for new deployments. Use the repository's single root `package-lock.json` and `npm ci`.

| Service | Provider | Root directory | Configuration | Start / health |
| --- | --- | --- | --- | --- |
| Website | Vercel | `frontend` | `frontend/vercel.json`, Next.js preset, Node 24 | Managed by Vercel |
| API and workers | Railway | `/` | `/backend/railway.json`, Railpack | `node backend/server.js`, `/api/health` |
| Hosted MCP | Railway | `/` | `/railway.json`, Railpack | `node mcp-server/server.js`, `/health` |
| Private VCR verifier | Railway | `/` | `/vcr-service/railway.json`, Railpack | `node vcr-service/server.js`, `/health` |
| Database | Railway | Managed PostgreSQL service | Fresh database, retained storage and backups | Private connection from API |

For Vercel, enable **Include source files outside of the Root Directory in the Build Step**. The checked-in install command runs `npm ci --prefix ..` from `frontend`, installing the complete workspace from its lockfile. The build command is `npm run build`. Disable deployment protection for any production or preview URL intended for public sharing.

For both Railway application services, keep the root at `/` even when selecting a nested config file. Railpack reads the root Node version and lockfile. Leave Railway's assigned `PORT` available; both servers read it.

## Redeploying an existing Vercel project

Select `codex/bard-agent-marketplace-20261110` as the deployment source and production branch. The reported build cloned `main` at `19b055e`, which still requests Node 20. Redeploying that old commit repeats the error; create a new deployment from the release branch. Both Railway application services should use this same branch.

In Vercel's **Build and Deployment** settings, use the Next.js preset, root `frontend`, Node **24.x**, install command `npm ci --prefix ..`, and build command `npm run build`. Enable inclusion of source files outside the root directory. The release already pins Node 24 in its package manifests. Vercel's error suggests its current default, Node 26, but [Node 24 remains supported](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions). A package's `engines.node` takes precedence over the dashboard selection, so changing the dropdown alone does not fix an old Node 20 commit.

## Environment and storage

Replace every angle-bracket placeholder before using these blocks. Generate the API and MCP public domains in Railway, then use their HTTPS origins without a trailing slash. Set real secrets in the hosting dashboards, not in Git or chat.

### Railway API service

Use the following variables with a **fresh** PostgreSQL service. `${{Postgres.DATABASE_URL}}` is Railway's variable reference syntax; replace `Postgres` with the database service's actual name.

```dotenv
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<NEW_RANDOM_SECRET_1>
MCP_INTERNAL_SECRET=<NEW_RANDOM_SECRET_2>
PLATFORM_OPERATOR_SECRET=<NEW_RANDOM_SECRET_3>
WALLET_MASTER_KEY=<NEW_RANDOM_SECRET_4>
WALLET_PROVIDER=local
MCP_ONLY_AGENT_API=true

CORS_ORIGIN=https://<YOUR_VERCEL_DOMAIN>
BARD_PUBLIC_API_URL=https://<YOUR_API_DOMAIN>
MCP_URL=https://<YOUR_MCP_DOMAIN>
UPLOADS_DIR=/data/uploads

ONCHAIN_ESCROW=true
ARC_TESTNET_RPC=https://rpc.testnet.arc.network
USDC_CONTRACT_ADDRESS=0x3600000000000000000000000000000000000000
AGENTIC_COMMERCE_ADDRESS=0x680e73Ff53981629b8B814cE9A69AD1347867606
BARD_JOB_HOOK_ADDRESS=0x097eF956B18E20A8E9b509791c2a430b2750f32b
PLATFORM_OWNER_WALLET=0xB804d506d5446b1A3BeBEfC903D84F754973C2D2
SELLER_ADDRESS=<BACKEND_MANAGED_EVALUATOR_ADDRESS>
BARD_VCR_MODE=registry
BARD_VCR_URL=http://bard-vcr.railway.internal:8080
BARD_VCR_SERVICE_SECRET=<NEW_RANDOM_SECRET_5>
BARD_VCR_DATABASE_PASSWORD=<NEW_RANDOM_SECRET_6>
BARD_VCR_POLICIES={}
BARD_GAS_MAX_WEI=0
BARD_GAS_DAILY_WEI=0
BARD_GAS_WALLET_DAILY_WEI=0
BARD_PLATFORM_MAX_WEI=0
BARD_PLATFORM_DAILY_WEI=0
BARD_PLATFORM_WALLET_DAILY_WEI=0
```

Generate the six secrets independently with `openssl rand -hex 32`. Retain `WALLET_MASTER_KEY` with the database: changing it prevents the backend from decrypting existing managed wallets. Mount an API volume at `/data`, or configure the supported R2 variables in [backend/.env.example](../backend/.env.example). The API currently enables PostgreSQL TLS in production; verify connectivity with the selected database template.

`SELLER_ADDRESS` must be an evaluator that the selected wallet provider can sign for, funded with Arc Testnet gas. The contract admin address and local Foundry keystore do not automatically provision that backend signer. Operator provisioning through `/api/admin/provision-platform-wallet` creates a managed wallet in the new backend and returns its public address; fund it and set `SELLER_ADDRESS` before accepting funded work. The existing preview uses the admin as a placeholder and is not settlement-ready. Keep the intended operator in `PLATFORM_OWNER_WALLET`.

For Passport, add these server-only values from [the Passport developer portal](https://developer.passport.xyz/):

```dotenv
PASSPORT_API_KEY=<PASSPORT_API_KEY>
PASSPORT_SCORER_ID=<PASSPORT_SCORER_ID>
```

Ethos uses its public API and defaults to `ETHOS_CLIENT_NAME=bard`; it needs no Passport key. Registry mode automatically enrolls each active agent's managed wallet through the private verifier. Keep `BARD_VCR_POLICIES={}`; this mode needs no address-by-address map. The API provisions a restricted `bard_vcr` database role after schema bootstrap. Give the verifier that role's connection string and the same service authentication secret, plus the approved limits and contract addresses:

```dotenv
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://bard_vcr:<PRIVATE_VCR_DATABASE_PASSWORD>@<PRIVATE_POSTGRES_HOST>:5432/railway
BARD_VCR_SERVICE_SECRET=<SAME_VALUE_AS_API_BARD_VCR_SERVICE_SECRET>
BARD_VCR_MAX_TX_USDC=100
BARD_VCR_DAILY_USDC=250
BARD_VCR_ALLOWED_RECIPIENTS=[]
AGENTIC_COMMERCE_ADDRESS=0x680e73Ff53981629b8B814cE9A69AD1347867606
BARD_JOB_HOOK_ADDRESS=0x097eF956B18E20A8E9b509791c2a430b2750f32b
```

Keep this verifier on Railway's private network. It receives no wallet master key, agent tokens, operator secret or Passport key. Missing, pending, revoked or unreachable policies block spending. Sponsor limits are independent and initially zero; agents need their own Arc gas balance. See [managed wallet policies](MANAGED-WALLET-POLICIES.md) for recipient rules, durable send retries and revocation.

An existing ENS/IPFS verifier remains supported with explicit external mode:

```dotenv
BARD_VCR_MODE=external
BARD_VCR_URL=https://<YOUR_VCR_SERVICE_DOMAIN>
BARD_VCR_POLICIES={"<LOWERCASE_AGENT_WALLET>":"<POLICY_ENS_NAME>"}
```

External mode calls `/api/verify` on that origin and requires its approved wallet-to-policy map. Registry mode uses Bard's authenticated database policy profile; it does not publish policies to ENS or IPFS. Turnkey credentials are unnecessary for the `local` provider. Circle faucet and R2 credentials are optional integrations; Binance stays disabled.

### Railway MCP service

```dotenv
NODE_ENV=production
BARD_API=https://<YOUR_API_DOMAIN>
MCP_INTERNAL_SECRET=<SAME_VALUE_AS_API_MCP_INTERNAL_SECRET>
CORS_ORIGIN=https://<YOUR_VERCEL_DOMAIN>
```

Use the exact same `MCP_INTERNAL_SECRET` on the API and MCP services. A Railway reference to the API service's variable can keep them synchronized. MCP does not need the database URL, wallet master key or Passport credentials. Its CORS origin can be omitted when no browser client uses MCP. Leave `PORT` to Railway on both services.

### Vercel frontend

```dotenv
NEXT_PUBLIC_API_URL=https://<YOUR_API_DOMAIN>
NEXT_PUBLIC_MCP_URL=https://<YOUR_MCP_DOMAIN>/mcp
```

Set these for the Vercel environment being deployed, then create a new build. Both values are public and embedded at build time; server credentials belong on Railway. The frontend MCP URL includes `/mcp`; the API's `MCP_URL` is the origin without that suffix. Use the Vercel production domain as the API's `CORS_ORIGIN`, and add specific preview origins only when needed. The full remaining release inputs are in [CURRENT.md](../agent-handoff/CURRENT.md).

## Rollout and verification

1. Select the reviewed GitHub revision. Create the fresh Railway PostgreSQL, API, MCP and private VCR services; configure storage, variables and public API/MCP domains.
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
