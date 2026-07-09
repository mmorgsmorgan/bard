#!/usr/bin/env node
/**
 * Refund-path lifecycles on Arc Testnet against the deployed contracts.
 *
 *   A. Rejection refund (fast)
 *      createJob → configure → setBudget → approve+depositFee → approve+fund
 *      → submit → reject(evaluator) → assert: client gets earnings + fee back
 *
 *   B. Expiry refund (slow — needs to wait past expiredAt)
 *      createJob (6-min expiry) → configure → setBudget → approve+depositFee
 *      → approve+fund → wait ~6.5 min → claimRefund + refundFee (anyone)
 *      → assert: client gets earnings + fee back
 *
 *   Roles
 *     client/treasury = W1 (0xA1a1…a3c8)
 *     provider        = W2 (0xB804…C2D2)
 *     evaluator       = W3 (0x46BC…c75b) (only used in path A)
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient, createWalletClient, http, keccak256, toBytes, formatUnits,
} from 'viem';
import {
  AGENTIC_COMMERCE_ADDRESS, BARD_JOB_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BARD_JOB_HOOK_ABI, ERC20_ABI, JobStatus, JobStatusName,
} from './erc8183-client.js';

const ARC_RPC = 'https://rpc.testnet.arc.network';
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

const AGENT_EARNINGS = 1_000_000n;   // 1.00 USDC
const PLATFORM_FEE   =   200_000n;   // 0.20 USDC
const MAX_BPS        = 2500;

const BAL_ABI = ERC20_ABI.concat([
  { type:'function', name:'balanceOf', stateMutability:'view',
    inputs:[{name:'a',type:'address'}], outputs:[{type:'uint256'}] },
]);
async function bal(addr) {
  return BigInt(await pub.readContract({ address: USDC_ADDRESS, abi: BAL_ABI, functionName:'balanceOf', args:[addr] }));
}
const fmt = (n) => formatUnits(n, 6);

async function writeAndWait(wc, params, label) {
  const hash = await wc.writeContract(params);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} failed: ${hash}`);
  console.log(`    ${label.padEnd(28)} ${hash.slice(0,18)}…  gas ${r.gasUsed}`);
  return r;
}

async function getJob(jobId) {
  return pub.readContract({ address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'getJob', args:[jobId] });
}
async function getFeeMeta(jobId) {
  return pub.readContract({ address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI, functionName:'getFeeMeta', args:[jobId] });
}
async function jobCounter() {
  return pub.readContract({
    address: AGENTIC_COMMERCE_ADDRESS,
    abi: ERC8183_ABI.concat([{type:'function',name:'jobCounter',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}]),
    functionName: 'jobCounter',
  });
}

// Common setup: createJob → configureBardJob → setBudget → depositFee → fund
async function setupFundedJob({ expirySeconds, label }) {
  const block = await pub.getBlock();
  const expiry = block.timestamp + BigInt(expirySeconds);
  const expectedJobId = (await jobCounter()) + 1n;
  console.log(`  ━ Setting up job (expiry ${expirySeconds}s from now, jobId will be ${expectedJobId}) ━`);

  await writeAndWait(client.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'createJob',
    args: [provider.account.address, evaluator.account.address, expiry, label, BARD_JOB_HOOK_ADDRESS, 0n],
  }, 'createJob');

  await writeAndWait(client.client, {
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI, functionName: 'configureBardJob',
    args: [expectedJobId, PLATFORM_FEE, client.account.address, MAX_BPS, 0],
  }, 'configureBardJob');

  await writeAndWait(provider.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'setBudget',
    args: [expectedJobId, USDC_ADDRESS, AGENT_EARNINGS, '0x'],
  }, 'setBudget');

  await writeAndWait(client.client, {
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [BARD_JOB_HOOK_ADDRESS, PLATFORM_FEE],
  }, 'approve hook');
  await writeAndWait(client.client, {
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI, functionName: 'depositFee', args: [expectedJobId],
  }, 'depositFee');

  await writeAndWait(client.client, {
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [AGENTIC_COMMERCE_ADDRESS, AGENT_EARNINGS],
  }, 'approve ac');
  await writeAndWait(client.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'fund',
    args: [expectedJobId, AGENT_EARNINGS, '0x'],
  }, 'fund');

  return expectedJobId;
}

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PATH A — Rejection refund');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const clientBeforeA   = await bal(client.account.address);
  const providerBeforeA = await bal(provider.account.address);

  const jobIdA = await setupFundedJob({ expirySeconds: 72 * 60 * 60, label: 'reject-test' });

  console.log('\n  ━ provider submits ━');
  await writeAndWait(provider.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'submit',
    args: [jobIdA, keccak256(toBytes('half-done')), '0x'],
  }, 'submit');

  console.log('\n  ━ evaluator rejects ━');
  await writeAndWait(evaluator.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'reject',
    args: [jobIdA, keccak256(toBytes('insufficient-quality')), '0x'],
  }, 'reject');

  const jobA = await getJob(jobIdA);
  const fmA  = await getFeeMeta(jobIdA);
  const clientAfterA   = await bal(client.account.address);
  const providerAfterA = await bal(provider.account.address);

  console.log('\n  ━ result ━');
  console.log('    job status        :', JobStatusName[jobA.status]);
  console.log('    feeSettled        :', fmA.feeSettled);
  console.log('    hook balance      :', fmt(await bal(BARD_JOB_HOOK_ADDRESS)));
  console.log('    ac balance        :', fmt(await bal(AGENTIC_COMMERCE_ADDRESS)));
  const clientNetA = clientAfterA - clientBeforeA;
  const providerNetA = providerAfterA - providerBeforeA;
  console.log('    client net change :', fmt(clientNetA), '(includes negative gas for 7 txs; expected ≈ −0.005)');
  console.log('    provider net      :', fmt(providerNetA), '(should be slightly negative from gas, no earnings)');

  const pathAOk =
    jobA.status === JobStatus.Rejected &&
    fmA.feeSettled === true &&
    (await bal(BARD_JOB_HOOK_ADDRESS)) === 0n &&
    (await bal(AGENTIC_COMMERCE_ADDRESS)) === 0n &&
    clientNetA > -100_000n;  // gas only, no escrow loss
  console.log('    ' + (pathAOk ? '✓ Rejection refund OK' : '✗ Rejection refund FAIL'));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PATH B — Expiry refund (needs ~6 min wait)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const clientBeforeB = await bal(client.account.address);

  // Min expiry per ERC8183 is now + 5 min. Pick 6 min so we don't race the floor.
  const EXPIRY_SEC = 6 * 60;
  const WAIT_SEC   = (EXPIRY_SEC + 30);  // 6 min + 30s safety

  const jobIdB = await setupFundedJob({ expirySeconds: EXPIRY_SEC, label: 'expiry-test' });

  console.log(`\n  ━ waiting ${WAIT_SEC}s for expiry to pass... ━`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_SEC * 1000) {
    const remaining = Math.ceil(((startedAt + WAIT_SEC * 1000) - Date.now()) / 1000);
    process.stdout.write(`\r    ${remaining}s remaining...   `);
    await new Promise(r => setTimeout(r, 5_000));
  }
  process.stdout.write('\r    expired.                  \n');

  console.log('\n  ━ anyone (using W3) calls claimRefund ━');
  await writeAndWait(evaluator.client, {
    address: AGENTIC_COMMERCE_ADDRESS, abi: ERC8183_ABI, functionName: 'claimRefund',
    args: [jobIdB],
  }, 'claimRefund');

  console.log('\n  ━ anyone (using W3) calls hook.refundFee ━');
  await writeAndWait(evaluator.client, {
    address: BARD_JOB_HOOK_ADDRESS, abi: BARD_JOB_HOOK_ABI, functionName: 'refundFee',
    args: [jobIdB],
  }, 'refundFee');

  const jobB = await getJob(jobIdB);
  const fmB  = await getFeeMeta(jobIdB);
  const clientAfterB = await bal(client.account.address);

  console.log('\n  ━ result ━');
  console.log('    job status        :', JobStatusName[jobB.status]);
  console.log('    feeSettled        :', fmB.feeSettled);
  console.log('    hook balance      :', fmt(await bal(BARD_JOB_HOOK_ADDRESS)));
  console.log('    ac balance        :', fmt(await bal(AGENTIC_COMMERCE_ADDRESS)));
  const clientNetB = clientAfterB - clientBeforeB;
  console.log('    client net change :', fmt(clientNetB), '(gas + funded+fee out, then fully refunded; expect ≈ −0.005)');

  const pathBOk =
    jobB.status === JobStatus.Expired &&
    fmB.feeSettled === true &&
    (await bal(BARD_JOB_HOOK_ADDRESS)) === 0n &&
    (await bal(AGENTIC_COMMERCE_ADDRESS)) === 0n &&
    clientNetB > -100_000n;
  console.log('    ' + (pathBOk ? '✓ Expiry refund OK' : '✗ Expiry refund FAIL'));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`    Path A (reject):  ${pathAOk ? 'PASS' : 'FAIL'}  jobId ${jobIdA}`);
  console.log(`    Path B (expiry):  ${pathBOk ? 'PASS' : 'FAIL'}  jobId ${jobIdB}`);
})().catch(e => { console.error('FAIL', e?.shortMessage || e?.message || e); process.exit(1); });
