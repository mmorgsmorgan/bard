#!/usr/bin/env node
/**
 * Full BARD escrow lifecycle on Arc Testnet, against the deployed contracts.
 *
 *   Roles
 *     client    = W1 (0xA1a1…a3c8)  pays the bounty
 *     provider  = W2 (0xB804…C2D2)  receives agent earnings
 *     evaluator = W3 (0x46BC…c75b)  attests deliverable
 *     treasury  = W1 (also)         receives platform fee
 *
 *   Flow (proposal mode — provider pre-bound at createJob)
 *     1. client    → ac.createJob(provider, evaluator, expiry, desc, hook, 0)
 *     2. client    → hook.configureBardJob(jobId, fee, treasury, maxBps, 0)
 *     3. provider  → ac.setBudget(jobId, USDC, earnings, "")
 *     4. client    → USDC.approve(hook, fee)
 *     5. client    → hook.depositFee(jobId)
 *     6. client    → USDC.approve(ac, earnings)
 *     7. client    → ac.fund(jobId, earnings, "")
 *     8. provider  → ac.submit(jobId, deliverable, "")
 *     9. evaluator → ac.complete(jobId, reason, "")
 *
 *   After step 9, the provider should hold +earnings and treasury +fee.
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient, createWalletClient, http, keccak256, toBytes, formatUnits,
} from 'viem';
import {
  AGENTIC_COMMERCE_ADDRESS, BARD_JOB_HOOK_ADDRESS, USDC_ADDRESS, publicClient as _ignore,
  ERC8183_ABI, BARD_JOB_HOOK_ABI, ERC20_ABI, JobStatus, JobStatusName,
} from './erc8183-client.js';

const ARC_RPC = 'https://rpc.testnet.arc.network';

// W1 (client + treasury), W2 (provider), W3 (evaluator)
const KEYS = {
  W1: '0x19f02090dd79e4ec67182e9cee3a71e9c225ee22613d6a56bff4b10c380ad2c0',
  W2: '0xc8ee7ed94c868a3a8bf183f004d577ff59f3f0cf74f8208362cb97b086624c4f',
  W3: '0xd2200ae0fc6c5e0ee1da5edb53a5ef2611606ee1c2d9f01a71d5659a631cdda6',
};

const chain = {
  id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC] } },
};
const pub = createPublicClient({ chain, transport: http(ARC_RPC) });

function w(key) {
  const account = privateKeyToAccount(key);
  return { account, client: createWalletClient({ account, chain, transport: http(ARC_RPC) }) };
}
const client    = w(KEYS.W1);
const provider  = w(KEYS.W2);
const evaluator = w(KEYS.W3);
const TREASURY  = client.account.address;  // W1 also acts as treasury

// Parameters
const AGENT_EARNINGS = 1_000_000n;    // 1.00 USDC
const PLATFORM_FEE   = 200_000n;      // 0.20 USDC
const MAX_BPS        = 2500;          // 25% cap (actual 16.67%)
const EXPIRY_OFFSET  = BigInt(72 * 60 * 60); // 72 hours

async function bal(addr) {
  return formatUnits(
    await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI.concat([
      { type:'function', name:'balanceOf', stateMutability:'view',
        inputs:[{name:'a',type:'address'}], outputs:[{type:'uint256'}] },
    ]), functionName:'balanceOf', args:[addr] }),
    6,
  );
}

async function sendAndWait(walletClient, opts, label) {
  const hash = await walletClient.sendTransaction(opts);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} failed: ${hash}`);
  console.log(`  ${label.padEnd(30)} ${hash}  (gas ${r.gasUsed})`);
  return r;
}

async function writeAndWait(walletClient, params, label) {
  const hash = await walletClient.writeContract(params);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} failed: ${hash}`);
  console.log(`  ${label.padEnd(30)} ${hash}  (gas ${r.gasUsed})`);
  return r;
}

(async () => {
  console.log('━━━ Targets ━━━');
  console.log('  ERC8183 (proxy):', AGENTIC_COMMERCE_ADDRESS);
  console.log('  BardJobHook    :', BARD_JOB_HOOK_ADDRESS);
  console.log('  USDC           :', USDC_ADDRESS);

  console.log('\n━━━ Roles ━━━');
  console.log('  client/treasury:', client.account.address);
  console.log('  provider       :', provider.account.address);
  console.log('  evaluator      :', evaluator.account.address);

  console.log('\n━━━ Balances before ━━━');
  console.log('  client   :', await bal(client.account.address));
  console.log('  provider :', await bal(provider.account.address));
  console.log('  evaluator:', await bal(evaluator.account.address));
  console.log('  hook     :', await bal(BARD_JOB_HOOK_ADDRESS));
  console.log('  ac       :', await bal(AGENTIC_COMMERCE_ADDRESS));

  // Read current jobCounter to derive the next jobId.
  const counterBefore = await pub.readContract({
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI.concat([
      { type:'function', name:'jobCounter', stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
    ]),
    functionName: 'jobCounter',
  });
  const expectedJobId = counterBefore + 1n;
  console.log(`\n━━━ Next jobId will be: ${expectedJobId} ━━━`);

  const block = await pub.getBlock();
  const expiry = block.timestamp + EXPIRY_OFFSET;

  console.log('\n━━━ Step 1: client → ac.createJob (proposal mode, provider pre-bound) ━━━');
  await writeAndWait(client.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'createJob',
    args: [provider.account.address, evaluator.account.address, expiry, 'lifecycle-test', BARD_JOB_HOOK_ADDRESS, 0n],
  }, 'createJob');

  console.log('\n━━━ Step 2: client → hook.configureBardJob ━━━');
  await writeAndWait(client.client, {
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI,
    functionName: 'configureBardJob',
    args: [expectedJobId, PLATFORM_FEE, TREASURY, MAX_BPS, 0],
  }, 'configureBardJob');

  console.log('\n━━━ Step 3: provider → ac.setBudget ━━━');
  await writeAndWait(provider.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'setBudget',
    args: [expectedJobId, USDC_ADDRESS, AGENT_EARNINGS, '0x'],
  }, 'setBudget');

  console.log('\n━━━ Step 4: client → USDC.approve(hook, fee) ━━━');
  await writeAndWait(client.client, {
    address: USDC_ADDRESS, abi: ERC20_ABI,
    functionName: 'approve', args: [BARD_JOB_HOOK_ADDRESS, PLATFORM_FEE],
  }, 'approve hook');

  console.log('\n━━━ Step 5: client → hook.depositFee ━━━');
  await writeAndWait(client.client, {
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI,
    functionName: 'depositFee', args: [expectedJobId],
  }, 'depositFee');

  console.log('\n━━━ Step 6: client → USDC.approve(ac, earnings) ━━━');
  await writeAndWait(client.client, {
    address: USDC_ADDRESS, abi: ERC20_ABI,
    functionName: 'approve', args: [AGENTIC_COMMERCE_ADDRESS, AGENT_EARNINGS],
  }, 'approve ac');

  console.log('\n━━━ Step 7: client → ac.fund ━━━');
  await writeAndWait(client.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'fund', args: [expectedJobId, AGENT_EARNINGS, '0x'],
  }, 'fund');

  console.log('\n━━━ Step 8: provider → ac.submit ━━━');
  await writeAndWait(provider.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'submit', args: [expectedJobId, keccak256(toBytes('deliverable-v1')), '0x'],
  }, 'submit');

  console.log('\n━━━ Step 9: evaluator → ac.complete ━━━');
  await writeAndWait(evaluator.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'complete', args: [expectedJobId, keccak256(toBytes('approved')), '0x'],
  }, 'complete');

  console.log('\n━━━ Final job state ━━━');
  const job = await pub.readContract({
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI,
    functionName: 'getJob', args: [expectedJobId],
  });
  console.log('  jobId        :', expectedJobId);
  console.log('  status       :', JobStatusName[job.status], `(${job.status})`);
  console.log('  client       :', job.client);
  console.log('  provider     :', job.provider);
  console.log('  evaluator    :', job.evaluator);
  console.log('  budget       :', formatUnits(job.budget, 6), 'USDC');
  console.log('  paymentToken :', job.paymentToken);

  const fm = await pub.readContract({
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI,
    functionName: 'getFeeMeta', args: [expectedJobId],
  });
  console.log('\n  FeeMeta:');
  console.log('    platformFee  :', formatUnits(fm.platformFee, 6), 'USDC');
  console.log('    feeRecipient :', fm.feeRecipient);
  console.log('    configured   :', fm.configured);
  console.log('    feeDeposited :', fm.feeDeposited);
  console.log('    feeSettled   :', fm.feeSettled);

  console.log('\n━━━ Balances after ━━━');
  console.log('  client   :', await bal(client.account.address));
  console.log('  provider :', await bal(provider.account.address), '(expected: +1.00)');
  console.log('  evaluator:', await bal(evaluator.account.address));
  console.log('  hook     :', await bal(BARD_JOB_HOOK_ADDRESS), '(expected: 0)');
  console.log('  ac       :', await bal(AGENTIC_COMMERCE_ADDRESS), '(expected: 0)');

  const ok = job.status === JobStatus.Completed
          && fm.feeSettled === true
          && (await bal(BARD_JOB_HOOK_ADDRESS)) === '0'
          && (await bal(AGENTIC_COMMERCE_ADDRESS)) === '0';
  console.log('\n' + (ok ? '✓ FULL ESCROW LIFECYCLE WORKS ON ARC TESTNET' : '✗ Something off — see numbers above'));
})().catch(e => { console.error('FAIL', e?.shortMessage || e?.message || e); process.exit(1); });
