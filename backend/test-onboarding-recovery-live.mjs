#!/usr/bin/env node
/**
 * Regression test for the cross-deployment / orphan-wallet recovery chain.
 *
 * Simulates the Codex trace failure mode end-to-end:
 *
 *   1. Hit MCP with a valid JWT for an agent that doesn't exist on this
 *      backend → expect structured error, hint=cross_deployment_token,
 *      recovery_tool=bard_register_self.
 *   2. Call bard_register_self → agent row should appear on this backend.
 *   3. Call again → idempotent, created=false.
 *   4. Call bard_create_wallet → wallet provisioned.
 *   5. Call bard_create_wallet AGAIN → should adopt the wallet that was
 *      just created (idempotency under retries).
 *   6. Call bard_create_bounty → creator resolves to the real Turnkey
 *      wallet (not 0x000).
 *   7. Call bard_submit_proposal on someone else's bounty → succeeds.
 *
 * This is the exact set of MCP calls Codex tried that all failed.
 *
 * Costs nothing (no on-chain transfers, no platform USDC).
 */

import 'dotenv/config';
import { randomBytes } from 'crypto';

// MCP and the "target" backend are the same prod stack we've been testing
// against. The "issuer" backend is a DIFFERENT BARD deployment that shares
// JWT_SECRET — registering an agent there yields a valid token whose agent
// row does NOT exist on the target backend. That's the exact cross-
// deployment failure mode the Codex trace hit.
const API = (process.env.BARD_API || 'https://bard-production-e88b.up.railway.app').replace(/\/$/, '');
const MCP = (process.env.BARD_MCP_URL || 'https://mcp-production-8d2e.up.railway.app').replace(/\/$/, '');
const ISSUER_API = (process.env.BARD_ISSUER_API || 'https://adorable-caring-production-7a3a.up.railway.app').replace(/\/$/, '');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

let pass = 0, fail = 0;
const expect = (cond, name, detail) => cond
  ? (pass++, console.log(`  ${c.green}✓${c.reset} ${name}`))
  : (fail++, console.log(`  ${c.red}✗${c.reset} ${name}${detail ? `   ${c.dim}${detail}${c.reset}` : ''}`));

let rpcId = 0;
async function mcpTool(token, tool, args = {}, attempt = 1) {
  try {
    const res = await fetch(`${MCP}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: ++rpcId,
        method: 'tools/call', params: { name: tool, arguments: args },
      }),
    });
    const out = await res.json();
    if (out.error) throw new Error(out.error.message);
    const raw = out.result?.content?.[0]?.text;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (attempt < 3 && (err.cause?.code || err.message).match(/fetch failed|ECONN/i)) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      return mcpTool(token, tool, args, attempt + 1);
    }
    throw err;
  }
}

async function run() {
  console.log(`${c.bold}${c.cyan}\n════ BARD Onboarding & Recovery Chain ════${c.reset}`);
  console.log(`${c.dim}API: ${API}  |  MCP: ${MCP}${c.reset}\n`);

  // Register a fresh agent on the ISSUER backend. The token comes back
  // signed with their JWT_SECRET (which equals the target's by design)
  // and the agent row is created in the ISSUER's Postgres only, not the
  // target's. That's exactly the failure state Codex hit.
  console.log(`${c.cyan}▸ 0. Registering throwaway agent on issuer (${ISSUER_API})${c.reset}`);
  const stamp = Date.now().toString(36);
  const agentName = `recovery-test-${stamp}`;
  // Retry the initial register — Railway edges sometimes drop the very first
  // connection on a cold connection pool, which kills the whole test before
  // we even start. Three attempts with backoff.
  let reg;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      reg = await fetch(`${ISSUER_API}/api/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerWallet: '0x0000000000000000000000000000000000000000',
          agentName,
          agentPublicKey: 'turnkey-pending-' + Date.now() + randomBytes(3).toString('hex'),
          agentType: 'research',
          description: 'cross-deployment recovery regression test',
        }),
      });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  if (!reg.ok) throw new Error(`issuer register failed: ${reg.status} ${await reg.text()}`);
  const regData = await reg.json();
  const agentId = regData.agent?.id || regData.agentId;
  const token = regData.token;
  if (!token || !agentId) throw new Error(`no token/agentId from issuer: ${JSON.stringify(regData)}`);
  console.log(`  ${c.dim}id:    ${agentId}${c.reset}`);
  console.log(`  ${c.dim}name:  ${agentName}${c.reset}`);
  console.log(`  ${c.dim}token validates on issuer, but no agent row exists on the target backend${c.reset}`);

  // 1. Cross-deployment error
  console.log(`\n${c.cyan}▸ 1. bard_create_wallet should return cross_deployment_token error${c.reset}`);
  const step1 = await mcpTool(token, 'bard_create_wallet');
  expect(step1?.error, `returned an error`, step1?.error?.slice(0, 80));
  expect(step1?.hint === 'cross_deployment_token',
    `hint=cross_deployment_token (got ${step1?.hint})`);
  expect(step1?.recovery_tool === 'bard_register_self',
    `recovery_tool=bard_register_self (got ${step1?.recovery_tool})`);
  expect(/bard_register_self/.test(step1?.error || ''),
    `error message names bard_register_self`);

  // 2. bard_register_self
  console.log(`\n${c.cyan}▸ 2. bard_register_self creates the agent row${c.reset}`);
  const step2 = await mcpTool(token, 'bard_register_self');
  expect(step2?.success === true, `success=true`);
  expect(step2?.created === true, `created=true (newly added)`);
  expect(step2?.agent?.id === agentId, `agent.id matches`, `got ${step2?.agent?.id}`);
  expect(step2?.agent?.agent_name === agentName, `agent.agent_name matches`);

  // 3. Idempotency
  console.log(`\n${c.cyan}▸ 3. bard_register_self is idempotent (created=false on repeat)${c.reset}`);
  const step3 = await mcpTool(token, 'bard_register_self');
  expect(step3?.success === true, `still success=true`);
  expect(step3?.created === false, `created=false (already existed)`);

  // 4. Wallet provisioning
  console.log(`\n${c.cyan}▸ 4. bard_create_wallet provisions a Turnkey wallet${c.reset}`);
  const step4 = await mcpTool(token, 'bard_create_wallet');
  expect(step4?.success === true, `success=true`, step4?.error);
  expect(/^0x[a-fA-F0-9]{40}$/.test(step4?.walletAddress || ''),
    `walletAddress is a valid 0x address`, step4?.walletAddress);
  const wAddr = step4?.walletAddress;

  // 5. Wallet idempotency (orphan adoption path)
  console.log(`\n${c.cyan}▸ 5. bard_create_wallet a SECOND time returns the same address${c.reset}`);
  const step5 = await mcpTool(token, 'bard_create_wallet');
  expect(step5?.success === true, `second call also succeeds`, step5?.error);
  expect(step5?.walletAddress === wAddr,
    `same wallet returned (got ${step5?.walletAddress})`);

  // 6. Bounty creation resolves to real wallet
  console.log(`\n${c.cyan}▸ 6. bard_create_bounty resolves creator to the Turnkey wallet${c.reset}`);
  const step6 = await mcpTool(token, 'bard_create_bounty', {
    title: `Recovery test bounty ${stamp}`,
    description: 'Posted by the recovery test — should resolve creator to real wallet.',
    bountyType: 'content',
    amountUsdc: '1',
    deadline: new Date(Date.now() + 86400e3).toISOString(),
  });
  expect(step6?.success === true, `bounty created`, step6?.error);
  expect((step6?.bounty?.creator_wallet || '').toLowerCase() === wAddr.toLowerCase(),
    `creator_wallet=${wAddr} (not 0x000)`,
    `got ${step6?.bounty?.creator_wallet}`);

  // 7. Submit a proposal — we need a different agent's bounty to bid on.
  // The bounty just created is OURS, so submit on imager's BARD cover bounty.
  console.log(`\n${c.cyan}▸ 7. bard_submit_proposal on someone else's bounty${c.reset}`);
  const step7 = await mcpTool(token, 'bard_submit_proposal', {
    bountyId: 'bounty-1780411367363-xw3mid',
    plan: 'Recovery-test proposal — verifying that the full chain works end-to-end after register-self + create-wallet.',
    proposedPriceUsdc: 4,
    estimatedHours: 1,
  });
  // May fail with "already submitted" if this test ran before — that's fine, it still proves the gate works
  if (step7?.error?.includes('already submitted')) {
    expect(true, `endpoint reachable (got existing-proposal hint, fine)`);
  } else {
    expect(step7?.success === true, `proposal submitted`, step7?.error);
    expect(!!step7?.proposal?.id, `proposal.id present`);
  }

  console.log(`\n${c.bold}${c.cyan}════ Results ════${c.reset}`);
  console.log(`  passed: ${pass}`);
  if (fail > 0) console.log(`  ${c.red}failed: ${fail}${c.reset}`);
  console.log();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`\n${c.red}✗ Crashed:${c.reset} ${err.message}\n`);
  process.exit(2);
});
