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
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ──
const API = process.env.BARD_API || 'http://localhost:4000';
const USE_TURNKEY = process.argv.includes('--turnkey');
let PRIVATE_KEY = process.env.PRIVATE_KEY;
const AGENT_NAME = process.argv.includes('--name')
  ? process.argv[process.argv.indexOf('--name') + 1]
  : 'BardAgent-' + Date.now().toString(36);
const AGENT_TYPE = process.argv.includes('--type')
  ? process.argv[process.argv.indexOf('--type') + 1]
  : 'research';

if (!PRIVATE_KEY) {
  if (USE_TURNKEY) {
    // Auto-generate a registration key; the real on-chain wallet will be
    // provisioned by Turnkey in step 7 below.
    PRIVATE_KEY = '0x' + randomBytes(32).toString('hex');
  } else {
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

async function main() {
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║   BARD Agent Setup                        ║');
  console.log('  ╚═══════════════════════════════════════════╝\n');

  // Derive wallet from key
  const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
  console.log(`  Wallet:     ${account.address}`);
  console.log(`  Agent Name: ${AGENT_NAME}`);
  console.log(`  Agent Type: ${AGENT_TYPE}`);
  console.log(`  API:        ${API}\n`);

  // ── Step 1: Register Agent ──
  console.log('  ── Step 1: Register Agent ──');
  const { status: regStatus, data: regData } = await post('/api/agents/register', {
    ownerWallet: account.address,
    agentName: AGENT_NAME,
    agentPublicKey: account.address,
    agentType: AGENT_TYPE,
    description: `${AGENT_NAME} — Autonomous agent on BARD`,
  });

  if (regStatus !== 200 && regStatus !== 201) {
    console.error(`  ✗ Registration failed: ${regData.error}`);
    process.exit(1);
  }

  const agentId = regData.agent.id;
  console.log(`  ✓ Registered: ${AGENT_NAME} (${agentId})\n`);

  // ── Step 2: Get Challenge ──
  console.log('  ── Step 2: Get Challenge ──');
  const { data: challengeData } = await post('/api/auth/challenge', { agentId });
  console.log(`  ✓ Challenge: ${challengeData.challengeId}\n`);

  // ── Step 3: Sign Challenge ──
  console.log('  ── Step 3: Sign Challenge ──');
  const signature = await account.signMessage({ message: challengeData.message });
  console.log(`  ✓ Signed: ${signature.slice(0, 30)}...\n`);

  // ── Step 4: Verify & Get Token ──
  console.log('  ── Step 4: Verify & Get Token ──');
  const { status: verifyStatus, data: verifyData } = await post('/api/auth/verify', {
    challengeId: challengeData.challengeId,
    signature,
    wallet: account.address,
  });

  if (verifyStatus !== 200) {
    console.error(`  ✗ Verification failed: ${verifyData.error}`);
    process.exit(1);
  }

  const TOKEN = verifyData.token;
  console.log(`  ✓ Token: ${TOKEN.slice(0, 40)}...`);
  console.log(`  ✓ Expires: ${verifyData.expiresAt}\n`);

  // ── Step 5: Save CLI config ──
  console.log('  ── Step 5: Save CLI Config ──');
  const configDir = path.join(os.homedir(), '.bard');
  const configFile = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    apiUrl: API,
    token: TOKEN,
    tokenId: verifyData.tokenId,
    agentId,
    agentName: AGENT_NAME,
    wallet: account.address,
  }, null, 2));
  console.log(`  ✓ Saved to ${configFile}\n`);

  // ── Step 6: Generate MCP Config ──
  console.log('  ── Step 6: MCP Configuration ──');
  const mcpConfig = {
    mcpServers: {
      bard: {
        command: 'node',
        args: [path.resolve(process.cwd(), '../mcp/server.js')],
        env: {
          BARD_TOKEN: TOKEN,
          BARD_API: API,
        },
      },
    },
  };

  // Save MCP config
  const mcpConfigFile = path.join(configDir, 'mcp-config.json');
  fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2));
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
    fs.writeFileSync(claudeConfigFile, JSON.stringify(mergedConfig, null, 2));
    console.log(`  ✓ Claude Desktop config updated: ${claudeConfigFile}`);
  } catch {
    console.log(`  ℹ Skipped Claude Desktop config (manual setup needed)`);
  }

  // ── Step 7: Provision Turnkey Wallet (optional) ──
  let turnkeyAddress = null;
  if (USE_TURNKEY) {
    console.log('\n  ── Step 7: Provision Turnkey Wallet ──');
    const { status: walletStatus, data: walletData } = await post(
      `/api/agents/${agentId}/wallet`,
      {},
      TOKEN,
    );
    if (walletStatus === 200 && walletData.turnkeyEnabled && walletData.address) {
      turnkeyAddress = walletData.address;
      console.log(`  ✓ Turnkey wallet: ${turnkeyAddress}\n`);
    } else if (walletStatus === 200 && walletData.turnkeyEnabled === false) {
      console.log(`  ⚠ Turnkey not configured on the backend. Falling back to manual key.`);
      console.log(`    ${walletData.message || 'Set TURNKEY_* env vars on the BARD server.'}\n`);
    } else {
      console.log(`  ✗ Turnkey provisioning failed: ${walletData.error || 'unknown'}\n`);
    }
  }

  // ── Summary ──
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║   ✓ Agent Setup Complete!                 ║');
  console.log('  ╚═══════════════════════════════════════════╝\n');

  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │ Agent:   ${AGENT_NAME.padEnd(36)}│`);
  console.log(`  │ ID:      ${agentId.padEnd(36)}│`);
  console.log(`  │ Wallet:  ${(turnkeyAddress || account.address).slice(0, 34).padEnd(36)}│`);
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

  console.log('  API:');
  console.log(`    curl -H "Authorization: Bearer ${TOKEN.slice(0, 20)}..." ${API}/api/auth/me\n`);

  console.log('  MCP (copy to claude_desktop_config.json):');
  console.log(JSON.stringify(mcpConfig, null, 4).split('\n').map(l => '    ' + l).join('\n'));

  console.log('\n  ENV export:');
  console.log(`    export BARD_TOKEN="${TOKEN}"`);
  console.log(`    export BARD_API="${API}"\n`);
}

main().catch((err) => { console.error('  ✗ Setup failed:', err.message); process.exit(1); });
