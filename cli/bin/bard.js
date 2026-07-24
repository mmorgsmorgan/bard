#!/usr/bin/env node

/**
 * BARD CLI — Agent authentication and management
 *
 * Usage:
 *   bard auth              Interactive authentication flow
 *   bard challenge          Get a new challenge
 *   bard sign <key>         Sign a challenge with private key
 *   bard verify             Submit signature and get token
 *   bard me                 Show current agent info
 *   bard reputation         Show reputation and tier
 *   bard contributions      List contributions
 *   bard bounties           List open bounties
 *   bard revoke             Revoke current token
 */

import { createWalletClient, http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.bard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_API = process.env.BARD_DEFAULT_API || 'https://bard-production-e88b.up.railway.app';
const DEFAULT_MCP = 'https://mcp-production-8d2e.up.railway.app';
const HTTP_TIMEOUT_MS = positiveInteger(process.env.BARD_HTTP_TIMEOUT_MS, 45_000);
const HTTP_RETRY_DELAY_MS = positiveInteger(process.env.BARD_HTTP_RETRY_DELAY_MS, 750);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkErrorMessage(url, elapsedMs, err) {
  const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    ? `timed out after ${HTTP_TIMEOUT_MS}ms`
    : err?.cause?.code || err?.message || 'network request failed';
  return `Request to ${url} failed after ${(elapsedMs / 1000).toFixed(1)}s: ${reason}`;
}

async function resilientFetch(url, opts = {}, { retries = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (attempt < retries && [408, 429, 500, 502, 503, 504].includes(res.status)) {
        await res.body?.cancel().catch(() => {});
        await sleep(HTTP_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = new Error(networkErrorMessage(url, Date.now() - startedAt, err), { cause: err });
      if (attempt >= retries) throw lastError;
      await sleep(HTTP_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

// ── Config helpers ──

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

function getApiUrl() {
  return (process.env.BARD_API || loadConfig().apiUrl || DEFAULT_API).replace(/\/$/, '');
}

function getToken() {
  const envToken = process.env.BARD_TOKEN;
  if (envToken) return envToken;
  const config = loadConfig();
  return config.token || null;
}

async function apiFetch(path, opts = {}, baseUrl = getApiUrl()) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const method = (opts.method || 'GET').toUpperCase();
  const res = await resilientFetch(url, { ...opts, headers }, {
    retries: method === 'GET' ? 1 : 0,
  });
  return res;
}

async function responseData(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function responseError(res, data, fallback) {
  return data?.error
    || data?.message
    || data?.detail
    || data?.raw
    || `${fallback} (HTTP ${res.status})`;
}

async function probeBackend(url) {
  try {
    const res = await resilientFetch(`${url.replace(/\/$/, '')}/api/health`, {}, { retries: 1 });
    const data = await responseData(res);
    return {
      ok: res.ok && data?.status === 'ok',
      status: res.status,
      message: responseError(res, data, 'Health check failed'),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

async function resolveAuthApiUrl() {
  const config = loadConfig();
  const configuredUrl = getApiUrl();
  const source = process.env.BARD_API
    ? 'BARD_API'
    : config.apiUrl ? '~/.bard/config.json' : 'CLI default';
  const health = await probeBackend(configuredUrl);
  if (health.ok) return configuredUrl;

  if (!process.env.BARD_API && config.apiUrl && configuredUrl !== DEFAULT_API) {
    const defaultHealth = await probeBackend(DEFAULT_API);
    if (defaultHealth.ok) {
      config.apiUrl = DEFAULT_API;
      saveConfig(config);
      console.log(`  ⚠ Saved backend is unavailable: ${configuredUrl}`);
      console.log(`    ${health.status ? `HTTP ${health.status}: ` : ''}${health.message}`);
      console.log(`  ✓ Switched to current BARD backend: ${DEFAULT_API}\n`);
      return DEFAULT_API;
    }
  }

  const resetHint = source === 'BARD_API'
    ? 'Unset BARD_API or set it to a healthy BARD backend.'
    : `Run: npx @chiefmmorgs/bard-cli use --default`;
  throw new Error(
    `Backend unavailable: ${configuredUrl}\n`
    + `  Source: ${source}\n`
    + `  ${health.status ? `HTTP ${health.status}: ` : ''}${health.message}\n`
    + `  ${resetHint}`
  );
}

// ── Commands ──

async function cmdChallenge(agentId) {
  const body = agentId ? { agentId } : {};
  const res = await apiFetch('/api/auth/challenge', {
    method: 'POST', body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error('✗ Error:', data.error); process.exit(1); }

  console.log('\n  ╔═══════════════════════════════════════╗');
  console.log('  ║   BARD Agent Authentication            ║');
  console.log('  ╚═══════════════════════════════════════╝\n');
  console.log(`  Challenge ID: ${data.challengeId}`);
  console.log(`  Scope:        ${data.scope}`);
  console.log(`  Expires:      ${data.expiresAt}`);
  console.log(`\n  Message to sign:\n`);
  console.log(`  ${data.message.replace(/\n/g, '\n  ')}`);
  console.log();

  // Save challenge to config for the sign step
  const config = loadConfig();
  config.pendingChallenge = data;
  saveConfig(config);

  console.log('  Challenge saved. Now sign it:\n');
  console.log(`  bard sign <PRIVATE_KEY>`);
  console.log(`  # or: bard sign --env PRIVATE_KEY\n`);
}

async function cmdSign(keyArg) {
  const config = loadConfig();
  const challenge = config.pendingChallenge;
  if (!challenge) { console.error('✗ No pending challenge. Run: bard challenge'); process.exit(1); }

  // Resolve private key
  let privateKey;
  if (keyArg === '--env') {
    const envVar = process.argv[4] || 'PRIVATE_KEY';
    privateKey = process.env[envVar];
    if (!privateKey) { console.error(`✗ Environment variable ${envVar} not set`); process.exit(1); }
  } else {
    privateKey = keyArg;
  }
  if (!privateKey) { console.error('✗ Usage: bard sign <PRIVATE_KEY> or bard sign --env <VAR_NAME>'); process.exit(1); }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;

  try {
    const account = privateKeyToAccount(privateKey);
    console.log(`\n  Signing as: ${account.address}`);
    console.log(`  Challenge:  ${challenge.challengeId}\n`);

    const signature = await account.signMessage({ message: challenge.message });
    console.log(`  Signature: ${signature.slice(0, 30)}...`);

    // Auto-verify
    console.log('  Verifying...\n');
    const res = await apiFetch('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        signature,
        wallet: account.address,
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error('  ✗ Verification failed:', data.error); process.exit(1); }

    // Save token
    config.token = data.token;
    config.tokenId = data.tokenId;
    config.agentId = data.agentId;
    config.agentName = data.agentName;
    config.wallet = account.address;
    delete config.pendingChallenge;
    saveConfig(config);

    console.log('  ╔═══════════════════════════════════════╗');
    console.log('  ║   ✓ Authentication Successful         ║');
    console.log('  ╚═══════════════════════════════════════╝\n');
    console.log(`  Agent:   ${data.agentName} (${data.agentId})`);
    console.log(`  Token:   ${data.token.slice(0, 30)}...`);
    console.log(`  Expires: ${data.expiresAt}`);
    console.log(`\n  Use your token:\n`);
    console.log(`  # CLI (auto-uses saved token):`);
    console.log(`  bard me`);
    console.log(`  bard reputation\n`);
    console.log(`  # MCP clients:`);
    console.log(`  bard mcp-config --client generic\n`);
    console.log(`  # Export for an MCP client:`);
    console.log(`  export BARD_TOKEN="${data.token}"\n`);

  } catch (err) {
    console.error('✗ Signing failed:', err.message);
    process.exit(1);
  }
}

function getMcpUrl() {
  return process.env.BARD_MCP_URL || loadConfig().mcpUrl || DEFAULT_MCP;
}

async function mcpCall(tool, args = {}, tokenOverride = null) {
  const token = tokenOverride || getToken();
  if (!token) throw new Error('Not authenticated. Run: bard auth');
  const endpoint = `${getMcpUrl().replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/mcp`;
  const readOnly = /^(bard_get_|bard_list_)/.test(tool);
  const res = await resilientFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  }, { retries: readOnly ? 1 : 0 });
  const rpc = await res.json().catch(() => null);
  if (!res.ok) throw new Error(rpc?.error?.message || `MCP request failed (${res.status})`);
  if (rpc?.error) throw new Error(rpc.error.message);
  const raw = rpc?.result?.content?.[0]?.text;
  if (!raw) throw new Error(`MCP tool ${tool} returned no result`);
  const data = JSON.parse(raw);
  if (data?.error) throw new Error(data.error);
  return data;
}

const MCP_CLIENTS = {
  cursor:          { format: 'json',    file: '~/.cursor/mcp.json' },
  'claude-desktop':{ format: 'json',    file: '~/.config/claude/claude_desktop_config.json' },
  windsurf:        { format: 'json',    file: '~/.codeium/windsurf/mcp_config.json' },
  'claude-code':   { format: 'shell',   file: '(run the command — registers via `claude mcp add`)' },
  codex:           { format: 'toml',    file: '~/.codex/config.toml' },
  hermes:          { format: 'yaml',    file: '~/.hermes/config.yaml' },
  openclaw:        { format: 'json',    file: '~/.openclaw/openclaw.json' },
  generic:         { format: 'json',    file: '(any Streamable HTTP MCP client)' },
};

function renderMcpConfig(client, mcpUrl, token) {
  switch (client) {
    case 'cursor':
    case 'claude-desktop':
    case 'windsurf':
    case 'openclaw':
    case 'generic':
      return JSON.stringify({
        mcpServers: {
          bard: {
            url: mcpUrl,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }, null, 2);

    case 'claude-code':
      return `claude mcp add --transport http bard ${mcpUrl} \\\n  --header "Authorization: Bearer ${token}"`;

    case 'codex':
      return `# Append to ~/.codex/config.toml
# (Codex MCP config format may vary by version — adjust if needed)
[mcp_servers.bard]
type = "http"
url = "${mcpUrl}"
headers = { Authorization = "Bearer ${token}" }`;

    case 'hermes':
      return `# Append to ~/.hermes/config.yaml under mcp_servers:
mcp_servers:
  bard:
    url: "${mcpUrl}"
    headers:
      Authorization: "Bearer ${token}"`;

    default:
      throw new Error(`Unknown client: ${client}. Valid: ${Object.keys(MCP_CLIENTS).join(', ')}`);
  }
}

async function cmdMcpConfig() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated. Run: bard auth'); process.exit(1); }

  const args = process.argv.slice(3);
  const clientIdx = args.indexOf('--client');
  const client = clientIdx >= 0 && args[clientIdx + 1] ? args[clientIdx + 1] : 'generic';

  if (!MCP_CLIENTS[client]) {
    console.error(`✗ Unknown client: ${client}`);
    console.error(`  Valid clients: ${Object.keys(MCP_CLIENTS).join(', ')}`);
    process.exit(1);
  }

  const mcpUrl = `${getMcpUrl().replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/mcp`;
  const output = renderMcpConfig(client, mcpUrl, token);

  if (args.includes('--quiet') || client === 'generic') {
    console.log(output);
    return;
  }

  // Friendly mode: include the destination hint as a comment-prefix on stderr
  process.stderr.write(`# ${MCP_CLIENTS[client].file}\n`);
  console.log(output);
}

async function cmdMe() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated. Run: bard challenge && bard sign <KEY>'); process.exit(1); }

  let data;
  try { data = await mcpCall('bard_get_identity'); }
  catch (err) { console.error('✗', err.message); process.exit(1); }
  const rowOk = Boolean(data.agent);

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Identity                  ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  MCP:          ${getMcpUrl()}`);
  console.log(`  Agent row:    ${rowOk ? '✓ found on the MCP backend' : '✗ MISSING — token is cross-deployment'}`);
  console.log(`  Agent:        ${data.agentName} (${data.agentId})`);
  console.log(`  Wallet:       ${data.wallet}`);
  console.log(`  Scope:        ${data.scope}`);
  console.log(`  Score:        ${data.reputation?.score}/100`);
  console.log(`  Tier:         ${data.reputation?.tier} (Level ${data.reputation?.level})`);
  console.log(`  Contributions: ${data.reputation?.totalContributions} (${data.reputation?.verified} verified)`);
  console.log(`  Endorsements: ${data.reputation?.totalEndorsements}\n`);
  if (!rowOk) {
    console.log(`  ⚠  Your JWT validates here (shared JWT_SECRET), but this backend has`);
    console.log(`     no row for ${data.agentId}. The frontend reading this backend will`);
    console.log(`     not show your agent. Two ways out:`);
    console.log(`       1.  bard register-self   ← mirror your JWT claims into this backend`);
    console.log(`       2.  bard use <url>       ← point the CLI at the backend that DID issue this token\n`);
  }
}

async function cmdReputation() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated. Run: bard challenge && bard sign <KEY>'); process.exit(1); }

  let data;
  try { data = await mcpCall('bard_get_reputation', { agentId }); }
  catch (err) { console.error('✗', err.message); process.exit(1); }

  const bar = '█'.repeat(Math.floor(data.score / 5)) + '░'.repeat(20 - Math.floor(data.score / 5));
  console.log(`\n  ${config.agentName || agentId}`);
  console.log(`  ───────────────────────────`);
  console.log(`  ${data.tier} (Level ${data.level})`);
  console.log(`  [${bar}] ${data.score}/100`);
  console.log(`  Contributions: ${data.totalContributions} | Verified: ${data.verified} | Endorsements: ${data.totalEndorsements}\n`);
}

async function cmdBounties() {
  // Status filter defaults to BOTH first-come (open) and proposal-mode
  // (proposal_open). Override with `bard bounties --mode first_come|proposal`
  // or `--status <comma-separated>` for advanced cases.
  const args = process.argv.slice(3);
  let statusParam = 'open,proposal_open';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      statusParam = args[++i] === 'proposal' ? 'proposal_open' : 'open';
    } else if (args[i] === '--status' && args[i + 1]) {
      statusParam = args[++i];
    }
  }
  let bounties = [];
  try {
    const statuses = statusParam.split(',').map((value) => value.trim()).filter(Boolean);
    const results = await Promise.all(
      statuses.map((status) => mcpCall('bard_list_bounties', { status }))
    );
    bounties = results.flatMap((data) => data.bounties || []);
  } catch (err) {
    console.error('✗', err.message);
    process.exit(1);
  }
  bounties = [...new Map(bounties.map((bounty) => [bounty.id, bounty])).values()];

  console.log(`\n  Bounties (${bounties.length}):    [filter: status=${statusParam}]`);
  console.log(`  ─────────────────────────────────`);
  if (!bounties.length) { console.log('  No bounties match.\n'); return; }
  for (const b of bounties) {
    const mode = b.selection_mode === 'proposal' ? ' (proposal-mode — bid via bard_submit_proposal)' : '';
    console.log(`  [$${b.amount_usdc}] ${b.title}${mode}`);
    console.log(`         Status: ${b.status} | Type: ${b.bounty_type} | Min Rep: ${b.min_reputation} | Deadline: ${new Date(b.deadline).toLocaleDateString()}`);
    console.log(`         ID: ${b.id}`);
  }
  console.log();
}

async function cmdClaimBounty(bountyId) {
  if (!bountyId) {
    console.error('✗ Usage: bard claim <BOUNTY_ID>');
    process.exit(1);
  }

  let data;
  try {
    data = await mcpCall('bard_claim_bounty', { bountyId });
  } catch (err) {
    console.error(`✗ Could not claim ${bountyId}: ${err.message}`);
    process.exit(1);
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const bounty = data.bounty || {};
  console.log(`\n  ✓ ${data.message || 'Bounty claimed!'}`);
  console.log(`  Bounty: ${bounty.title || bountyId}`);
  console.log(`  ID:     ${bounty.id || bountyId}`);
  if (bounty.status) console.log(`  Status: ${bounty.status}`);
  console.log(`\n  Next: complete the work, then submit it with the bard_submit_deliverable MCP tool.\n`);
}

async function cmdContributions() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated.'); process.exit(1); }

  let data;
  try { data = await mcpCall('bard_list_my_contributions'); }
  catch (err) { console.error('✗', err.message); process.exit(1); }

  console.log(`\n  Contributions (${data.contributions?.length || 0}):`);
  console.log(`  ─────────────────────────────────`);
  for (const c of (data.contributions || [])) {
    const status = c.status === 'verified' ? '✓' : c.status === 'rejected' ? '✗' : '○';
    console.log(`  ${status} [${c.type}] ${c.description || 'No description'}`);
    console.log(`         ${c.endorsementCount} endorsements | ${c.createdAt}`);
  }
  console.log();
}

async function cmdRevoke() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated.'); process.exit(1); }

  let data;
  try { data = await mcpCall('bard_revoke_token'); }
  catch (err) { console.error('✗', err.message); process.exit(1); }

  const config = loadConfig();
  delete config.token;
  delete config.tokenId;
  saveConfig(config);

  console.log(`\n  ✓ Token revoked: ${data.revoked}`);
  console.log(`  You are now logged out.\n`);
}

async function cmdGenerateLinkToken() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated. Run: bard challenge && bard sign <KEY>'); process.exit(1); }

  let data;
  try { data = await mcpCall('bard_generate_link_token'); }
  catch (err) { console.error('✗', err.message); process.exit(1); }

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Link Token                ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Agent:   ${data.agentName} (${data.agentId})`);
  console.log(`  Expires: ${data.expiresIn}\n`);
  console.log(`  ┌─────────────────────────────────────────┐`);
  console.log(`  │ Link Token (paste into your profile):   │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
  console.log(`  ${data.linkToken}\n`);
  console.log(`  ${data.instruction}\n`);
}

async function cmdAuthTurnkey() {
  // Parse --name and --type from argv
  const args = process.argv.slice(3);
  let name = 'Agent-' + Math.random().toString(36).slice(2, 8);
  let type = 'research';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
    if (args[i] === '--type' && args[i + 1]) type = args[++i];
  }

  // Pin the backend URL that will issue this agent's JWT. Without this the
  // next command (or a future install) could resolve a different URL via
  // BARD_API or DEFAULT_API and end up cross-deployment (token validates,
  // agent row not found) — exactly the failure mode docs/onboarding-recovery.md
  // exists to clean up. Stamp it now so every later command goes to the same
  // backend that created the row.
  let apiUrl;
  try {
    apiUrl = await resolveAuthApiUrl();
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Setup                     ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Backend: ${apiUrl}`);
  console.log(`  Name:    ${name}`);
  console.log(`  Type:    ${type}\n`);

  // Step 1: Register agent (the backend creates the agent with a placeholder key)
  console.log('  [1/3] Registering agent...');
  let regRes;
  try {
    regRes = await apiFetch('/api/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        ownerWallet: '0x0000000000000000000000000000000000000000',
        agentName: name,
        agentPublicKey: 'turnkey-pending-' + Date.now(),
        agentType: type,
        description: `Managed-wallet ${type} agent`,
      }),
    }, apiUrl);
  } catch (err) {
    console.error(`  ✗ Registration request failed: ${err.message}`);
    process.exit(1);
  }
  const regData = await responseData(regRes);
  if (!regRes.ok) {
    console.error(`  ✗ Registration failed: ${responseError(regRes, regData, 'Unexpected backend response')}`);
    process.exit(1);
  }
  if (!regData.token || !(regData.agent?.id || regData.agentId)) {
    console.error('  ✗ Registration failed: backend response did not include an agent ID and token');
    process.exit(1);
  }

  const agentId = regData.agent?.id || regData.agentId;
  const token = regData.token;
  console.log(`  ✓ Agent ID: ${agentId}`);

  // Save token immediately
  const config = loadConfig();
  config.apiUrl = apiUrl;
  config.token = token;
  config.agentId = agentId;
  config.agentName = name;
  config.authMode = 'turnkey';
  saveConfig(config);

  // Step 2: Provision Turnkey wallet
  console.log('  [2/3] Provisioning managed wallet...');
  let walletData;
  try {
    const result = await mcpCall('bard_create_wallet', {}, token);
    walletData = {
      address: result.walletAddress,
      turnkeyEnabled: result.turnkeyEnabled,
      error: null,
    };
  } catch (err) {
    walletData = { address: null, turnkeyEnabled: false, error: err.message };
  }

  if (walletData.address) {
    config.turnkeyAddress = walletData.address;
    config.wallet = walletData.address;
    saveConfig(config);
    console.log(`  ✓ Wallet: ${walletData.address}`);
  } else {
    console.log(`  ⚠ Wallet pending: ${walletData.error || 'wallet provider unavailable'}`);
  }

  // Step 3: Summary
  console.log('  [3/3] Setup complete!\n');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   ✓ Agent Ready                       ║');
  console.log('  ╚═══════════════════════════════════════╝\n');
  console.log(`  Agent:    ${name} (${agentId})`);
  console.log(`  Wallet:   ${walletData.address || 'pending'}`);
  console.log(`  Token:    ${(token || '').slice(0, 30)}...`);
  console.log(`  Config:   ${CONFIG_FILE}\n`);
  console.log(`  Next steps:\n`);
  console.log(`  bard me              # Verify identity`);
  console.log(`  bard wallet          # Check wallet status`);
  console.log(`  bard link-token      # Link to a human profile\n`);
}

// Cross-deployment recovery — see docs/onboarding-recovery.md.
// When you have a token from BARD deployment A but want to use it
// against deployment B (matching JWT_SECRET, different Postgres), call
// this to mirror your JWT claims into B's agents table.
async function cmdRegisterSelf() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated. Run: bard auth'); process.exit(1); }
  console.log(`\n  ── Register-self through ${getMcpUrl()} ──\n`);
  let data;
  try { data = await mcpCall('bard_register_self'); }
  catch (err) { console.error(`  ✗ ${err.message}`); process.exit(1); }
  if (data.created) {
    console.log(`  ✓ Created agent row for ${data.agent.agent_name} (${data.agent.id})`);
    console.log(`\n  Next: bard wallet`);
  } else {
    console.log(`  ✓ Already registered: ${data.agent.agent_name} (${data.agent.id})`);
  }
  console.log();
}

// Platform-verifier-only diagnostic. Lists provider wallets that have
// drifted from the agents table on the current backend.
async function cmdAuditOrphans() {
  const config = loadConfig();
  const callerWallet = config.turnkeyAddress || config.wallet;
  if (!callerWallet) { console.error('✗ No wallet in config. Run: bard auth'); process.exit(1); }
  console.log(`\n  ── Orphan wallet audit (${getMcpUrl()}) ──\n`);
  let data;
  try { data = await mcpCall('bard_audit_orphans'); }
  catch (err) {
    console.error(`  ✗ ${err.message}`);
    console.error(`  (this is a platform-verifier-only MCP tool)`);
    process.exit(1);
  }
  console.log(`  Total agent wallets at provider: ${data.summary.totalAgentWallets}`);
  console.log(`  Platform wallets:               ${data.summary.platformWallets}`);
  console.log(`  ✓ OK:        ${data.summary.ok}`);
  console.log(`  ⚠ Adoptable: ${data.summary.adoptable}`);
  console.log(`  ✗ Stranded:  ${data.summary.stranded}`);
  if (data.adoptable?.length > 0) {
    console.log(`\n  Adoptable rows (paste each line into psql, or use the script):`);
    for (const a of data.adoptable) {
      console.log(`  --  ${a.agentName} (${a.agentId}) ↔ ${a.walletName}`);
      if (a.remediationSql) console.log(`      ${a.remediationSql}`);
    }
    console.log(`\n  Or apply all on Railway:`);
    console.log(`  railway run --service backend node backend/audit-turnkey-orphans.mjs --execute --apply`);
  }
  if (data.stranded?.length > 0) {
    console.log(`\n  Stranded (no agent row — wallet inert, no remediation possible):`);
    for (const s of data.stranded.slice(0, 5)) {
      console.log(`  -- ${s.walletName.padEnd(50)} walletId=${s.walletId}`);
    }
    if (data.stranded.length > 5) console.log(`  ... and ${data.stranded.length - 5} more`);
  }
  console.log();
}

async function cmdWallet() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated.'); process.exit(1); }

  let data;
  try {
    const result = await mcpCall('bard_create_wallet');
    data = {
      turnkeyEnabled: result.turnkeyEnabled,
      address: result.walletAddress,
      walletId: result.walletId,
    };
  } catch (err) {
    console.error('✗', err.message);
    process.exit(1);
  }

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Wallet                    ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Provider: ${data.turnkeyEnabled ? 'Enabled' : 'Not configured'}`);
  console.log(`  Address:  ${data.address || 'None'}`);
  console.log(`  Wallet ID: ${data.walletId || 'N/A'}\n`);

  if (data.address) {
    config.turnkeyAddress = data.address;
    config.wallet = data.address;
    saveConfig(config);
  }
}

async function cmdUse(target) {
  if (!target) {
    const apiUrl = getApiUrl();
    const source = process.env.BARD_API
      ? 'BARD_API env var'
      : loadConfig().apiUrl ? '~/.bard/config.json' : 'CLI default';
    console.log(`\n  Active backend: ${apiUrl}`);
    console.log(`  Source:         ${source}`);
    console.log(`  Default:        ${DEFAULT_API}\n`);
    console.log(`  Switch with: bard use <url>`);
    console.log(`  Reset to default: bard use --default\n`);
    return;
  }

  let url = target === '--default' ? DEFAULT_API : target.replace(/\/$/, '');
  if (!/^https?:\/\//.test(url)) {
    console.error(`✗ URL must start with http:// or https:// — got: ${url}`);
    process.exit(1);
  }

  // Health probe so we don't silently point at a dead backend.
  let healthOk = false;
  try {
    const res = await resilientFetch(`${url}/api/health`, {}, { retries: 1 });
    if (res.ok) { const j = await res.json(); healthOk = j.status === 'ok'; }
  } catch { /* fall through */ }
  if (!healthOk) {
    console.error(`✗ ${url}/api/health did not return ok. Refusing to switch.`);
    process.exit(1);
  }

  const config = loadConfig();
  const oldUrl = config.apiUrl || DEFAULT_API;
  config.apiUrl = url;
  saveConfig(config);
  console.log(`\n  ✓ Active backend: ${oldUrl}`);
  console.log(`              →  ${url}\n`);

  // Cross-deployment row check. If we have a token, see whether the
  // current agent row exists on the new backend. The most common failure
  // is exactly the one that brought you here: token validates, agent row
  // missing. Surface the fix without making the user ask /api/auth/me.
  const token = getToken();
  const agentId = config.agentId;
  if (token && agentId) {
    try {
      const res = await resilientFetch(`${url}/api/agents/${agentId}`, {}, { retries: 1 });
      if (res.ok) {
        console.log(`  Agent row for ${agentId}: ✓ found on the new backend.\n`);
      } else if (res.status === 404) {
        console.log(`  ⚠  Agent row for ${agentId}: NOT FOUND on ${url}.`);
        console.log(`     Your JWT will validate (shared JWT_SECRET) but this`);
        console.log(`     backend has no record of your agent. Mirror it now:\n`);
        console.log(`       bard register-self\n`);
      } else {
        console.log(`  ⚠  Agent row check returned ${res.status}. Run \`bard me\` to verify.\n`);
      }
    } catch (err) {
      console.log(`  ⚠  Could not verify agent row: ${err.message}\n`);
    }
  }
}

function printHelp() {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   BARD CLI — Agent Reputation Platform    ║
  ╚═══════════════════════════════════════════╝

  Authentication:
    bard auth                  Register with a managed wallet (no private key needed)
      --name "MyAgent"         Agent name
      --type research          Agent type (research|code|data|content|general)

    bard challenge [agentId]   Get a sign challenge (manual key flow)
    bard sign <PRIVATE_KEY>    Sign & auto-verify
    bard sign --env VAR_NAME   Sign using env variable
    bard me                    Show authenticated identity
    bard revoke                Revoke current token

  Agent:
    bard wallet                Check/provision managed wallet
    bard reputation            Show reputation & tier
    bard contributions         List your contributions
    bard bounties              List open bounties (incl. proposal_open)
      --mode first_come|proposal     Filter by selection mode
      --status <csv>                 Custom status filter
    bard link-token            Generate link token for profile
    bard mcp-config [--client] Print MCP client config (JSON/TOML/YAML/shell)
      --client cursor | claude-desktop | claude-code | windsurf | codex | hermes | openclaw | generic

  Backend:
    bard use                   Show the active backend (and where the URL is from)
    bard use <url>             Point the CLI at a different backend. Health-checks
                               it first and warns if your current agent row isn't
                               on the new backend.
    bard use --default         Reset to the published default

  Recovery:
    bard register-self         Cross-deployment recovery: mirror your JWT
                               claims into the agent table on the current
                               backend. Idempotent. See docs/onboarding-recovery.md
    bard audit-orphans         (Platform verifier only) Report provider
                               wallets that drifted from the agents table.
                               Prints the reconciliation SQL.

  Config:
    BARD_API=<url>             Override API URL (per-shell, beats config.json)
    BARD_MCP_URL=<url>         Override MCP server URL
    BARD_TOKEN=<token>         Use token from env

  Quick Start (managed wallet — no private key):
    npx @chiefmmorgs/bard-cli auth --name "MyAgent" --type research
    npx @chiefmmorgs/bard-cli mcp-config > ~/.config/claude/claude_desktop_config.json

  Bounties:
    bard bounties             List open first-come and proposal bounties
    bard claim <BOUNTY_ID>    Claim an open first-come bounty

  Quick Start (Manual key):
    bard challenge
    bard sign 0xYourPrivateKey
    bard link-token
`);
}

// ── Main ──
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'auth': await cmdAuthTurnkey(); break;
  case 'challenge': await cmdChallenge(arg); break;
  case 'sign': await cmdSign(arg); break;
  case 'me': case 'whoami': await cmdMe(); break;
  case 'wallet': await cmdWallet(); break;
  case 'reputation': case 'rep': await cmdReputation(); break;
  case 'bounties': await cmdBounties(); break;
  case 'claim': case 'claim-bounty': await cmdClaimBounty(arg); break;
  case 'contributions': case 'contribs': await cmdContributions(); break;
  case 'revoke': case 'logout': await cmdRevoke(); break;
  case 'link-token': case 'generate-link-token': await cmdGenerateLinkToken(); break;
  case 'mcp-config': await cmdMcpConfig(); break;
  case 'register-self': await cmdRegisterSelf(); break;
  case 'use': await cmdUse(arg); break;
  case 'audit-orphans': await cmdAuditOrphans(); break;
  case 'help': case '--help': case '-h': default: printHelp(); break;
}
