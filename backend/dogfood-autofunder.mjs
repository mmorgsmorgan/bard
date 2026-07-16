#!/usr/bin/env node
/**
 * Dogfood auto-funder — background infrastructure so autonomous test agents never
 * get stuck on funding (funding friction is NOT the rails behaviour we're testing).
 *
 * Polls prod for agents whose name starts with the test prefix, and tops up any
 * whose on-chain USDC balance is below a floor — transferring from the funded W1
 * actor. Invisible to the agents; it does not touch or steer their decisions.
 *
 * Env: DOGFOOD_PREFIX (default "dogfood-"), BARD_API, BARD_TEST_W1.
 */
import 'dotenv/config';
import { fundAddress } from './fund-address.mjs';
import * as escrow from './escrow-service.js';

const API = process.env.BARD_API || 'https://bard-production-e88b.up.railway.app';
const PREFIX = process.env.DOGFOOD_PREFIX || 'dogfood-';
const FLOOR = 3.0;      // top up any test agent below 3 USDC
const TOPUP = 5.0;      // to ~5 USDC
const GAS_FLOOR = 0.3;  // and keep native gas above 0.3

async function agents() {
  try {
    const r = await fetch(`${API}/api/agents`).then(r => r.json());
    const list = Array.isArray(r) ? r : (r.agents || []);
    return list.filter(a => (a.agent_name || a.agentName || '').startsWith(PREFIX));
  } catch { return []; }
}

async function tick() {
  const ts = new Date().toISOString().slice(11, 19);
  const list = await agents();
  for (const a of list) {
    const addr = a.turnkey_address || a.turnkeyAddress || a.owner_wallet || a.ownerWallet;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    try {
      const usdc = escrow.fromUsdcWei(await escrow.usdcBalance(addr));
      const nativeWei = await escrow.nativeBalance(addr);
      const native = Number(nativeWei) / 1e18;
      const needUsdc = usdc < FLOOR ? +(TOPUP - usdc).toFixed(6) : 0;
      const needGas = native < GAS_FLOOR ? 0.5 : 0;
      if (needUsdc > 0 || needGas > 0) {
        await fundAddress(addr, { usdc: needUsdc, native: needGas });
        console.log(`[${ts}] topped ${a.agent_name || a.agentName} ${addr.slice(0,8)} +${needUsdc} USDC +${needGas} gas (was ${usdc.toFixed(2)}/${native.toFixed(2)})`);
      }
    } catch (e) {
      console.log(`[${ts}] skip ${addr.slice(0,8)}: ${e.message.slice(0,60)}`);
    }
  }
}

console.log(`dogfood-autofunder: prefix="${PREFIX}" floor=${FLOOR} api=${API}`);
await tick();
setInterval(tick, 20000);
