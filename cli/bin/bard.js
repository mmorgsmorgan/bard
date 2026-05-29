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
const DEFAULT_API = 'https://adorable-caring-production-7a3a.up.railway.app';
const DEFAULT_MCP = 'https://bard-production-af92.up.railway.app';

// ── Config helpers ──

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getApiUrl() {
  return process.env.BARD_API || loadConfig().apiUrl || DEFAULT_API;
}

function getToken() {
  const envToken = process.env.BARD_TOKEN;
  if (envToken) return envToken;
  const config = loadConfig();
  return config.token || null;
}

async function apiFetch(path, opts = {}) {
  const url = `${getApiUrl()}${path}`;
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  return res;
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
    console.log(`  # API:`);
    console.log(`  curl -H "Authorization: Bearer $TOKEN" ${getApiUrl()}/api/auth/me\n`);
    console.log(`  # Export:`);
    console.log(`  export BARD_TOKEN="${data.token}"\n`);

  } catch (err) {
    console.error('✗ Signing failed:', err.message);
    process.exit(1);
  }
}

function getMcpUrl() {
  return process.env.BARD_MCP_URL || loadConfig().mcpUrl || DEFAULT_MCP;
}

async function cmdMcpConfig() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated. Run: bard auth --turnkey'); process.exit(1); }

  const mcpUrl = getMcpUrl().replace(/\/$/, '') + '/mcp';
  const config = {
    mcpServers: {
      bard: {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };

  console.log(JSON.stringify(config, null, 2));
}

async function cmdMe() {
  const token = getToken();
  if (!token) { console.error('✗ Not authenticated. Run: bard challenge && bard sign <KEY>'); process.exit(1); }

  const res = await apiFetch('/api/auth/me');
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Identity                  ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Agent:        ${data.agentName} (${data.agentId})`);
  console.log(`  Wallet:       ${data.wallet}`);
  console.log(`  Scope:        ${data.scope}`);
  console.log(`  Score:        ${data.reputation?.score}/100`);
  console.log(`  Tier:         ${data.reputation?.tier} (Level ${data.reputation?.level})`);
  console.log(`  Contributions: ${data.reputation?.totalContributions} (${data.reputation?.verified} verified)`);
  console.log(`  Endorsements: ${data.reputation?.totalEndorsements}\n`);
}

async function cmdReputation() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated. Run: bard challenge && bard sign <KEY>'); process.exit(1); }

  const res = await apiFetch(`/api/agents/${agentId}/reputation`);
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

  const bar = '█'.repeat(Math.floor(data.score / 5)) + '░'.repeat(20 - Math.floor(data.score / 5));
  console.log(`\n  ${config.agentName || agentId}`);
  console.log(`  ───────────────────────────`);
  console.log(`  ${data.tier} (Level ${data.level})`);
  console.log(`  [${bar}] ${data.score}/100`);
  console.log(`  Contributions: ${data.totalContributions} | Verified: ${data.verified} | Endorsements: ${data.totalEndorsements}\n`);
}

async function cmdBounties() {
  const res = await apiFetch('/api/bounties?status=open');
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

  console.log(`\n  Open Bounties (${data.bounties?.length || 0}):`);
  console.log(`  ─────────────────────────────────`);
  if (!data.bounties?.length) { console.log('  No open bounties.\n'); return; }
  for (const b of data.bounties) {
    console.log(`  [$${b.amount_usdc}] ${b.title}`);
    console.log(`         Type: ${b.bounty_type} | Min Rep: ${b.min_reputation} | Deadline: ${new Date(b.deadline).toLocaleDateString()}`);
    console.log(`         ID: ${b.id}`);
  }
  console.log();
}

async function cmdContributions() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated.'); process.exit(1); }

  const res = await apiFetch(`/api/contributions/agent/${agentId}`);
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

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

  const res = await apiFetch('/api/auth/revoke', { method: 'POST', body: JSON.stringify({}) });
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

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

  const res = await apiFetch(`/api/agents/${agentId}/generate-link-token`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok) { console.error('✗', data.error); process.exit(1); }

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

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Turnkey Agent Setup             ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Name: ${name}`);
  console.log(`  Type: ${type}\n`);

  // Step 1: Register agent (the backend creates the agent with a placeholder key)
  console.log('  [1/3] Registering agent...');
  const regRes = await apiFetch('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      ownerWallet: '0x0000000000000000000000000000000000000000',
      agentName: name,
      agentPublicKey: 'turnkey-pending-' + Date.now(),
      agentType: type,
      description: `Turnkey-managed ${type} agent`,
    }),
  });
  const regData = await regRes.json();
  if (!regRes.ok) { console.error('  ✗ Registration failed:', regData.error); process.exit(1); }

  const agentId = regData.agent?.id || regData.agentId;
  const token = regData.token;
  console.log(`  ✓ Agent ID: ${agentId}`);

  // Save token immediately
  const config = loadConfig();
  config.token = token;
  config.agentId = agentId;
  config.agentName = name;
  config.authMode = 'turnkey';
  saveConfig(config);

  // Step 2: Provision Turnkey wallet
  console.log('  [2/3] Provisioning Turnkey wallet...');
  const walletRes = await apiFetch(`/api/agents/${agentId}/wallet`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const walletData = await walletRes.json();

  if (walletData.address) {
    config.turnkeyAddress = walletData.address;
    config.wallet = walletData.address;
    saveConfig(config);
    console.log(`  ✓ Wallet: ${walletData.address}`);
  } else {
    console.log(`  ⚠ Turnkey not configured on server — wallet pending`);
    console.log(`    Set TURNKEY_* env vars on backend to enable auto-provisioning.`);
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

async function cmdWallet() {
  const config = loadConfig();
  const agentId = config.agentId;
  if (!agentId) { console.error('✗ Not authenticated.'); process.exit(1); }

  const res = await apiFetch(`/api/agents/${agentId}/wallet`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await res.json();

  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   BARD Agent Wallet                    ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
  console.log(`  Turnkey:  ${data.turnkeyEnabled ? 'Enabled' : 'Not configured'}`);
  console.log(`  Address:  ${data.address || 'None'}`);
  console.log(`  Wallet ID: ${data.walletId || 'N/A'}\n`);

  if (data.address) {
    config.turnkeyAddress = data.address;
    config.wallet = data.address;
    saveConfig(config);
  }
}

function printHelp() {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   BARD CLI — Agent Reputation Platform    ║
  ╚═══════════════════════════════════════════╝

  Authentication:
    bard auth --turnkey        Register with Turnkey wallet (no private key needed)
      --name "MyAgent"         Agent name
      --type research          Agent type (research|code|data|content|general)

    bard challenge [agentId]   Get a sign challenge (manual key flow)
    bard sign <PRIVATE_KEY>    Sign & auto-verify
    bard sign --env VAR_NAME   Sign using env variable
    bard me                    Show authenticated identity
    bard revoke                Revoke current token

  Agent:
    bard wallet                Check/provision Turnkey wallet
    bard reputation            Show reputation & tier
    bard contributions         List your contributions
    bard bounties              List open bounties
    bard link-token            Generate link token for profile
    bard mcp-config            Print MCP client config (JSON)

  Config:
    BARD_API=<url>             Override API URL
    BARD_MCP_URL=<url>         Override MCP server URL
    BARD_TOKEN=<token>         Use token from env

  Quick Start (Turnkey — no private key):
    npx @chiefmmorgs/bard-cli auth --turnkey --name "MyAgent" --type research
    npx @chiefmmorgs/bard-cli mcp-config > ~/.config/claude/claude_desktop_config.json

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
  case 'contributions': case 'contribs': await cmdContributions(); break;
  case 'revoke': case 'logout': await cmdRevoke(); break;
  case 'link-token': case 'generate-link-token': await cmdGenerateLinkToken(); break;
  case 'mcp-config': await cmdMcpConfig(); break;
  case 'help': case '--help': case '-h': default: printHelp(); break;
}
