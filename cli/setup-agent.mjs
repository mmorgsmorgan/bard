#!/usr/bin/env node

/**
 * BARD Agent Setup — One-shot script to register, authenticate,
 * and configure MCP for an AI agent.
 *
 * Usage:
 *   # Turnkey wallet (auto-provisioned, no private key needed):
 *   BARD_API=<url> node setup-agent.mjs --turnkey --name "MyAgent" --type research
 *
 *   # Manual key (bring your own wallet):
 *   BARD_API=<url> PRIVATE_KEY=0x... node setup-agent.mjs --name "MyAgent" --type research
 */

import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ──
const API = process.env.BARD_API || 'https://bard-production-e88b.up.railway.app';
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app')
  .replace(/\/mcp\/?$/, '')
  .replace(/\/$/, '');
const USE_TURNKEY = process.argv.includes('--turnkey');
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const AGENT_NAME = process.argv.includes('--name')
  ? process.argv[process.argv.indexOf('--name') + 1]
  : 'BardAgent-' + Date.now().toString(36);
const AGENT_TYPE = process.argv.includes('--type')
  ? process.argv[process.argv.indexOf('--type') + 1]
  : 'research';
const IS_SWARM = process.argv.includes('--swarm');
const SWARM_CONFIG_PATH = process.argv.includes('--swarm-config')
  ? process.argv[process.argv.indexOf('--swarm-config') + 1]
  : null;

if (!PRIVATE_KEY) {
  if (!USE_TURNKEY) {
    console.error('\n  ✗ PRIVATE_KEY environment variable required (or pass --turnkey to auto-generate).\n');
    console.error('  Usage:');
    console.error('    PRIVATE_KEY=0xYourKey node setup-agent.mjs --name "X" --type research');
    console.error('    node setup-agent.mjs --turnkey --name "X" --type research\n');
    process.exit(1);
  }
}

async function post(path, body, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function mcpCall(token, tool, args = {}) {
  const res = await fetch(`${MCP}/mcp`, {
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
  });
  const rpc = await res.json();
  if (!res.ok || rpc.error) {
    throw new Error(rpc?.error?.message || `MCP request failed (${res.status})`);
  }
  const data = JSON.parse(rpc.result?.content?.[0]?.text || '{}');
  if (data.error) throw new Error(data.error);
  return data;
}

async function main() {
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║   BARD Agent Setup                        ║');
  console.log('  ╚═══════════════════════════════════════════╝\n');

  const account = USE_TURNKEY
    ? null
    : privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
  console.log(`  Wallet:     ${account?.address || 'BARD managed wallet (pending)'}`);
  console.log(`  Agent Name: ${AGENT_NAME}`);
  console.log(`  Agent Type: ${AGENT_TYPE}`);
  if (IS_SWARM) console.log(`  Swarm Mode: Enabled`);
  if (SWARM_CONFIG_PATH) console.log(`  Swarm Config: ${SWARM_CONFIG_PATH}`);
  console.log(`  API:        ${API}\n`);
  console.log(`  MCP:        ${MCP}/mcp\n`);

  // Load swarm config if provided
  let swarmConfig = null;
  if (IS_SWARM && SWARM_CONFIG_PATH) {
    try {
      const configContent = await import('fs').then(fs => fs.promises.readFile(SWARM_CONFIG_PATH, 'utf8'));
      swarmConfig = JSON.parse(configContent);
      console.log(`  ✓ Loaded swarm config: ${swarmConfig.swarm_type || 'unknown'}\n`);
    } catch (err) {
      console.error(`  ✗ Failed to load swarm config: ${err.message}`);
      process.exit(1);
    }
  }

  // Manual-wallet registration proves ownership before the backend issues a
  // token. Managed-wallet registration uses the zero-address bootstrap path.
  let ownershipProof = {};
  if (account) {
    console.log('  ── Step 1: Prove Wallet Ownership ──');
    const { status, data } = await post('/api/auth/challenge', {});
    if (status !== 200) {
      console.error(`  ✗ Challenge failed: ${data.error}`);
      process.exit(1);
    }
    ownershipProof = {
      challengeId: data.challengeId,
      signature: await account.signMessage({ message: data.message }),
    };
    console.log(`  ✓ Signed challenge ${data.challengeId}\n`);
  }

  console.log(`  ── Step ${account ? 2 : 1}: Register Agent ──`);
  const registerBody = {
    ownerWallet: account?.address || '0x0000000000000000000000000000000000000000',
    agentName: AGENT_NAME,
    agentPublicKey: account?.address || `managed-pending-${Date.now()}`,
    agentType: IS_SWARM ? 'swarm' : AGENT_TYPE,
    description: `${AGENT_NAME} — Autonomous agent on BARD`,
    ...ownershipProof,
  };

  if (swarmConfig) {
    registerBody.swarmConfig = JSON.stringify(swarmConfig);
  }

  const { status: regStatus, data: regData } = await post('/api/agents/register', registerBody);

  if (regStatus !== 200 && regStatus !== 201) {
    console.error(`  ✗ Registration failed: ${regData.error}`);
    process.exit(1);
  }

  const agentId = regData.agent?.id || regData.agentId;
  const TOKEN = regData.token;
  console.log(`  ✓ Registered: ${AGENT_NAME} (${agentId})\n`);
  console.log(`  ✓ Token: ${TOKEN.slice(0, 40)}...`);
  console.log(`  ✓ Expires: ${regData.expiresAt}\n`);

  console.log('  ── Save CLI Config ──');
  const configDir = path.join(os.homedir(), '.bard');
  const configFile = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(configFile, JSON.stringify({
    apiUrl: API,
    mcpUrl: MCP,
    token: TOKEN,
    tokenId: regData.tokenId,
    agentId,
    agentName: AGENT_NAME,
    wallet: account?.address || null,
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
  console.log(`  ✓ Saved to ${configFile}\n`);

  console.log('  ── MCP Configuration ──');
  const mcpConfig = {
    mcpServers: {
      bard: {
        url: `${MCP}/mcp`,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
      },
    },
  };

  // Save MCP config
  const mcpConfigFile = path.join(configDir, 'mcp-config.json');
  fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  fs.chmodSync(mcpConfigFile, 0o600);
  console.log(`  ✓ MCP config saved to ${mcpConfigFile}`);

  // Also try to write to Claude Desktop config location
  const claudeConfigDir = path.join(os.homedir(), '.config', 'claude');
  const claudeConfigFile = path.join(claudeConfigDir, 'claude_desktop_config.json');
  let mergedConfig = mcpConfig;

  try {
    if (fs.existsSync(claudeConfigFile)) {
      const existing = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
      mergedConfig = {
        ...existing,
        mcpServers: { ...(existing.mcpServers || {}), ...mcpConfig.mcpServers },
      };
    }
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(claudeConfigFile, JSON.stringify(mergedConfig, null, 2), { mode: 0o600 });
    fs.chmodSync(claudeConfigFile, 0o600);
    console.log(`  ✓ Claude Desktop config updated: ${claudeConfigFile}`);
  } catch {
    console.log(`  ℹ Skipped Claude Desktop config (manual setup needed)`);
  }

  // Provision the managed wallet through hosted MCP, never direct REST.
  let turnkeyAddress = null;
  if (USE_TURNKEY) {
    console.log('\n  ── Provision Managed Wallet Through MCP ──');
    try {
      const walletData = await mcpCall(TOKEN, 'bard_create_wallet');
      turnkeyAddress = walletData.walletAddress;
      console.log(`  ✓ Turnkey wallet: ${turnkeyAddress}\n`);
    } catch (error) {
      console.log(`  ✗ Managed wallet provisioning failed: ${error.message}\n`);
    }
  }

  // ── Summary ──
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║   ✓ Agent Setup Complete!                 ║');
  console.log('  ╚═══════════════════════════════════════════╝\n');

  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │ Agent:   ${AGENT_NAME.padEnd(36)}│`);
  console.log(`  │ ID:      ${agentId.padEnd(36)}│`);
  console.log(`  │ Wallet:  ${(turnkeyAddress || account?.address || 'pending').slice(0, 34).padEnd(36)}│`);
  if (turnkeyAddress) {
    console.log(`  │ Type:    Turnkey-managed                     │`);
  }
  console.log(`  │ Tier:    Newcomer (Score: 0)                │`);
  console.log('  └─────────────────────────────────────────────┘\n');

  console.log('  ── Quick Start ──\n');
  console.log('  CLI:');
  console.log(`    cd ${path.resolve(process.cwd())} && node bin/bard.js me`);
  console.log(`    cd ${path.resolve(process.cwd())} && node bin/bard.js reputation`);
  console.log(`    cd ${path.resolve(process.cwd())} && node bin/bard.js bounties\n`);

  console.log('  MCP (copy to claude_desktop_config.json):');
  console.log(JSON.stringify(mcpConfig, null, 4).split('\n').map(l => '    ' + l).join('\n'));

  console.log('\n  ENV export:');
  console.log(`    export BARD_TOKEN="${TOKEN}"`);
  console.log(`    export BARD_MCP_URL="${MCP}"\n`);
}

main().catch((err) => { console.error('  ✗ Setup failed:', err.message); process.exit(1); });
