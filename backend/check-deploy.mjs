#!/usr/bin/env node
/**
 * BARD deploy sanity check.
 *
 * Reads the environment (locally via .env, or on Railway via the live
 * service's process.env) and confirms the BARD backend is wired up for
 * on-chain operations BEFORE a user triggers the release/refund path
 * and discovers a missing piece the hard way.
 *
 * Validates:
 *   - JWT_SECRET set and not the dev placeholder
 *   - DATABASE_URL reachable (when pg is installed)
 *   - SELLER_ADDRESS + PLATFORM_OWNER_WALLET set, valid EIP-55 checksum,
 *     not the malformed historical default
 *   - TURNKEY_API_* triplet set, credentials work, SELLER_ADDRESS exists
 *     as a real account in the configured Turnkey org
 *   - USDC_CONTRACT_ADDRESS resolves to a deployed contract on the RPC
 *     and balanceOf returns sensible data (i.e. NOT the Base Sepolia
 *     address that silently returns 0x on Arc)
 *   - Platform wallet has a non-zero USDC balance
 *
 * Usage:
 *   node check-deploy.mjs                  # check local env
 *   node check-deploy.mjs --url <api-url>  # also probe live /api/health
 *   node check-deploy.mjs --strict         # treat warnings as failures
 *
 * Exit codes:
 *   0  all critical checks passed
 *   1  one or more critical checks failed (don't deploy)
 *   2  unexpected error
 *
 * On Railway:
 *   railway run --service backend node check-deploy.mjs
 */

import 'dotenv/config';
import { createPublicClient, http, isAddress, getAddress } from 'viem';

const args = process.argv.slice(2);
const URL_ARG = args.find(a => a.startsWith('--url='))?.split('=')[1] || args[args.indexOf('--url') + 1];
const STRICT = args.includes('--strict');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
let crit = 0, warn = 0, ok = 0;
const fail = (m, hint) => { crit++; console.log(`  ${c.red}✗ FAIL${c.reset} ${m}${hint ? `\n         ${c.dim}→ ${hint}${c.reset}` : ''}`); };
const wrn = (m, hint) => { warn++; console.log(`  ${c.yellow}⚠ WARN${c.reset} ${m}${hint ? `\n         ${c.dim}→ ${hint}${c.reset}` : ''}`); };
const pass = (m) => { ok++; console.log(`  ${c.green}✓ OK${c.reset}   ${m}`); };
const info = (m) => console.log(`         ${c.dim}${m}${c.reset}`);
const section = (n) => console.log(`\n${c.cyan}▸ ${n}${c.reset}`);

// Historical bad defaults to catch
const BAD_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'; // Base Sepolia
const BAD_SELLER = '0xb93e4681a57e2bf801e223e13ba3b1b3c042e28a';
const BAD_SELLER_MALFORMED = '0xb93e4681a57e2bf801e223e1e0ae8e6c6e6e6e6e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';

async function main() {
  console.log(`\n${c.cyan}════ BARD Deploy Sanity Check ════${c.reset}`);
  info(`NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);
  info(`Strict mode: ${STRICT}`);
  if (URL_ARG) info(`Remote probe: ${URL_ARG}`);

  // ── 1. Core app env ─────────────────────────────────────
  section('1. Core app config');
  const jwt = process.env.JWT_SECRET;
  if (!jwt) {
    fail('JWT_SECRET is not set', 'The backend will refuse to boot in production. Set in Railway env.');
  } else if (jwt === 'dev-secret-key-change-in-production' || jwt.length < 24) {
    fail('JWT_SECRET is the dev placeholder or too short', 'Generate a real one: openssl rand -hex 32');
  } else {
    pass(`JWT_SECRET set (length ${jwt.length})`);
  }

  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set');
  } else {
    pass(`DATABASE_URL set (host ${new URL(process.env.DATABASE_URL).hostname})`);
  }

  if (process.env.NODE_ENV !== 'production') {
    wrn(`NODE_ENV is "${process.env.NODE_ENV || 'unset'}"`, 'Should be "production" on Railway');
  } else {
    pass('NODE_ENV=production');
  }

  // ── 2. Platform wallet identity ─────────────────────────
  section('2. Platform wallet identity');
  const seller = process.env.SELLER_ADDRESS;
  const owner = process.env.PLATFORM_OWNER_WALLET;
  let sellerChecksum = null;

  if (!seller) {
    fail('SELLER_ADDRESS not set', 'Falls back to a hardcoded address you do not control. Set explicitly.');
  } else if (!isAddress(seller, { strict: false })) {
    fail(`SELLER_ADDRESS "${seller}" is not a valid Ethereum address`);
  } else {
    try {
      sellerChecksum = getAddress(seller);
      if (sellerChecksum !== seller) {
        wrn(`SELLER_ADDRESS has non-canonical checksum case`,
          `Canonical: ${sellerChecksum} — viem accepts lowercase but EIP-55 is recommended`);
      } else {
        pass(`SELLER_ADDRESS valid (${sellerChecksum})`);
      }
      if (seller.toLowerCase() === BAD_SELLER || seller.toLowerCase() === BAD_SELLER_MALFORMED) {
        fail('SELLER_ADDRESS is one of the historical bad defaults',
          'This wallet is not in your Turnkey org. Use a wallet you own.');
      }
    } catch (e) {
      fail(`SELLER_ADDRESS checksum invalid: ${e.message}`);
    }
  }

  if (!owner) {
    wrn('PLATFORM_OWNER_WALLET not set', `Will default to SELLER_ADDRESS (${seller || 'unset'})`);
  } else if (!isAddress(owner, { strict: false })) {
    fail(`PLATFORM_OWNER_WALLET "${owner}" is not a valid Ethereum address`);
  } else {
    pass(`PLATFORM_OWNER_WALLET valid (${getAddress(owner)})`);
    if (seller && owner.toLowerCase() !== seller.toLowerCase()) {
      info(`Note: PLATFORM_OWNER_WALLET differs from SELLER_ADDRESS — only the owner can call /platform-verify`);
    }
  }

  // ── 3. USDC contract reachable on RPC ───────────────────
  section('3. USDC contract');
  const usdcRaw = process.env.USDC_CONTRACT_ADDRESS;
  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const chainId = 5042002;
  let usdcAddr = usdcRaw || ARC_USDC;
  let usdcOk = false;

  if (!usdcRaw) {
    pass(`USDC_CONTRACT_ADDRESS unset — using new default ${ARC_USDC} (Arc Testnet)`);
  } else if (usdcRaw.toLowerCase() === BAD_USDC) {
    fail(`USDC_CONTRACT_ADDRESS is ${usdcRaw}`,
      `That is Base Sepolia's USDC, not Arc Testnet's. Use ${ARC_USDC} or unset to take the new default.`);
  } else if (!isAddress(usdcRaw, { strict: false })) {
    fail(`USDC_CONTRACT_ADDRESS "${usdcRaw}" is not a valid address`);
  } else if (usdcRaw.toLowerCase() === ARC_USDC.toLowerCase()) {
    pass(`USDC_CONTRACT_ADDRESS set to Arc Testnet's ${ARC_USDC}`);
  } else {
    wrn(`USDC_CONTRACT_ADDRESS=${usdcRaw} — not the canonical Arc address`,
      `Expected ${ARC_USDC} unless you have a specific reason to override.`);
  }

  // Live RPC contract probe
  if (sellerChecksum && isAddress(usdcAddr, { strict: false })) {
    try {
      const client = createPublicClient({
        chain: { id: chainId, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
        transport: http(rpc),
      });
      const raw = await client.readContract({
        address: usdcAddr,
        abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [sellerChecksum],
      });
      const bal = Number(raw) / 1_000_000;
      usdcOk = true;
      pass(`USDC contract reachable; balanceOf(SELLER_ADDRESS) = ${bal.toFixed(6)} USDC`);
      if (bal === 0) {
        fail('Platform wallet has 0 USDC',
          'Fund via Circle faucet: POST https://api.circle.com/v1/faucet/drips with {"address":"<SELLER_ADDRESS>","blockchain":"ARC-TESTNET","usdc":true}');
      } else if (bal < 10) {
        wrn(`Platform balance only ${bal.toFixed(2)} USDC — low`,
          'You can only cover ~' + Math.floor(bal) + ' release(s) before refilling.');
      } else {
        pass(`Platform balance ${bal.toFixed(2)} USDC — healthy`);
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('returned no data') || msg.includes('not a contract')) {
        fail(`USDC contract call returned no data at ${usdcAddr}`,
          `The address has no balanceOf — almost certainly the Base Sepolia USDC on the wrong chain. Use ${ARC_USDC}.`);
      } else {
        fail(`Could not query USDC contract: ${msg.split('\n')[0]}`);
      }
    }
  }

  // ── 4. Turnkey credentials ──────────────────────────────
  section('4. Turnkey signing credentials');
  const tkPriv = process.env.TURNKEY_API_PRIVATE_KEY;
  const tkPub = process.env.TURNKEY_API_PUBLIC_KEY;
  const tkOrg = process.env.TURNKEY_ORGANIZATION_ID;
  const tkOk = tkPriv && tkPub && tkOrg;

  if (!tkPriv) fail('TURNKEY_API_PRIVATE_KEY not set');
  if (!tkPub) fail('TURNKEY_API_PUBLIC_KEY not set');
  if (!tkOrg) fail('TURNKEY_ORGANIZATION_ID not set');
  if (tkOk) pass('Turnkey credential triplet present');

  // Live Turnkey probe + verify SELLER_ADDRESS is in the org
  if (tkOk && sellerChecksum) {
    try {
      const { Turnkey } = await import('@turnkey/sdk-server');
      const tk = new Turnkey({
        defaultOrganizationId: tkOrg,
        apiBaseUrl: 'https://api.turnkey.com',
        apiPrivateKey: tkPriv,
        apiPublicKey: tkPub,
      });
      const api = tk.apiClient();
      const { wallets } = await api.getWallets({ organizationId: tkOrg });
      pass(`Turnkey API auth works — found ${wallets.length} wallet(s) in org`);

      // Hunt for the SELLER_ADDRESS among accounts
      let found = null;
      for (const w of wallets) {
        const { accounts } = await api.getWalletAccounts({ organizationId: tkOrg, walletId: w.walletId });
        for (const a of accounts) {
          if (a.address.toLowerCase() === sellerChecksum.toLowerCase()) {
            found = { wallet: w.walletName, walletId: w.walletId, path: a.path };
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        pass(`SELLER_ADDRESS found in Turnkey org`);
        info(`wallet: ${found.wallet}  (${found.walletId})  path: ${found.path}`);
      } else {
        fail(`SELLER_ADDRESS ${sellerChecksum} is NOT in Turnkey org ${tkOrg}`,
          `Every release/refund will fail. Either set SELLER_ADDRESS to a wallet you own, or createWallet() in this org.`);
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('401') || msg.includes('unauthorized') || msg.toLowerCase().includes('signature')) {
        fail('Turnkey auth rejected', `API keys don't match the org ${tkOrg}. ${msg.split('\n')[0]}`);
      } else {
        fail(`Turnkey API error: ${msg.split('\n')[0]}`);
      }
    }
  }

  // ── 5. Optional: probe live backend ─────────────────────
  if (URL_ARG) {
    section(`5. Live backend probe (${URL_ARG})`);
    try {
      const res = await fetch(`${URL_ARG.replace(/\/$/, '')}/api/health`);
      if (!res.ok) {
        fail(`/api/health returned ${res.status}`);
      } else {
        const h = await res.json();
        pass(`backend up (uptime ${Math.round(h.uptime)}s, db=${h.db})`);
        if (h.turnkey !== true) {
          fail(`Live backend reports turnkey=${h.turnkey}`,
            'The deployed env is missing TURNKEY_* — set them in Railway and redeploy.');
        } else {
          pass('Live backend reports turnkey: true');
        }
        if (h.platformWallet?.error) {
          fail(`Live backend cannot read platform balance: ${h.platformWallet.error}`);
        } else if (h.platformWallet?.balance_usdc != null) {
          info(`Live balance: ${h.platformWallet.balance_usdc} USDC (status: ${h.platformWallet.status})`);
        }
        if (h.sellerAddress?.toLowerCase() !== sellerChecksum?.toLowerCase()) {
          wrn(`Live sellerAddress (${h.sellerAddress}) differs from local SELLER_ADDRESS (${sellerChecksum})`,
            'Local .env and Railway env are out of sync.');
        }
      }
    } catch (e) {
      fail(`Cannot reach ${URL_ARG}: ${e.message.split('\n')[0]}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────
  console.log(`\n${c.cyan}════ Summary ════${c.reset}`);
  console.log(`  ${c.green}✓ OK:    ${ok}${c.reset}`);
  if (warn > 0) console.log(`  ${c.yellow}⚠ WARN:  ${warn}${c.reset}`);
  if (crit > 0) console.log(`  ${c.red}✗ FAIL:  ${crit}${c.reset}`);

  const effectiveFail = crit > 0 || (STRICT && warn > 0);
  if (effectiveFail) {
    console.log(`\n${c.red}NOT SAFE TO DEPLOY — resolve the failures above first.${c.reset}\n`);
    process.exit(1);
  } else if (warn > 0) {
    console.log(`\n${c.yellow}Deploy is OK but warnings are worth a look.${c.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${c.green}All checks passed. Safe to deploy.${c.reset}\n`);
    process.exit(0);
  }
}

main().catch(e => {
  console.error(`\n${c.red}Check crashed:${c.reset}`, e);
  process.exit(2);
});
