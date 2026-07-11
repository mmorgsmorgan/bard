#!/usr/bin/env node
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { testKey } from './test-wallets.mjs';

const ARC_RPC = 'https://rpc.testnet.arc.network';
// Secure redeploy 2026-07-10 (old 0xa0756c/0x12131e were owned by a leaked key).
const AC      = process.env.AGENTIC_COMMERCE_ADDRESS || '0x417b10f3abB5355465e0c6B95B6Ee561e5aB42B5';
const HOOK    = process.env.BARD_JOB_HOOK_ADDRESS    || '0x356Cde3c6E0218bDfE67D3B6c04D311A510958eE';
const USDC    = '0x3600000000000000000000000000000000000000';
const W3_KEY  = testKey('W3');

const chain = { id: 5042002, name:'Arc', nativeCurrency:{name:'USDC',symbol:'USDC',decimals:6}, rpcUrls:{default:{http:[ARC_RPC]}}};
const pub = createPublicClient({ chain, transport: http(ARC_RPC) });
const wc  = createWalletClient({ account: privateKeyToAccount(W3_KEY), chain, transport: http(ARC_RPC) });

const BAL_ABI = [{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{name:'a',type:'address'}],outputs:[{type:'uint256'}]}];
const AC_ABI = [
  { type:'function', name:'claimRefund', stateMutability:'nonpayable', inputs:[{name:'jobId',type:'uint256'}], outputs:[] },
  { type:'function', name:'jobCounter', stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  { type:'function', name:'getJob', stateMutability:'view', inputs:[{name:'jobId',type:'uint256'}], outputs:[
    { type:'tuple', components:[
      {name:'client',type:'address'},{name:'status',type:'uint8'},{name:'provider',type:'address'},{name:'expiredAt',type:'uint48'},
      {name:'evaluator',type:'address'},{name:'submittedAt',type:'uint48'},{name:'budget',type:'uint256'},{name:'hook',type:'address'},
      {name:'paymentToken',type:'address'},{name:'providerAgentId',type:'uint256'},{name:'description',type:'string'},
    ]},
  ]},
];
const HOOK_ABI = [
  { type:'function', name:'refundFee', stateMutability:'nonpayable', inputs:[{name:'jobId',type:'uint256'}], outputs:[] },
  { type:'function', name:'getFeeMeta', stateMutability:'view', inputs:[{name:'jobId',type:'uint256'}], outputs:[
    { type:'tuple', components:[
      {name:'platformFee',type:'uint128'},{name:'feeRecipient',type:'address'},{name:'maxFeeBps',type:'uint16'},
      {name:'minRepScore',type:'uint16'},{name:'configured',type:'bool'},{name:'feeDeposited',type:'bool'},{name:'feeSettled',type:'bool'},
    ]},
  ]},
];
const STATUS = ['Open','Funded','Submitted','Completed','Rejected','Expired'];

const bal = async (a) => formatUnits(await pub.readContract({ address: USDC, abi: BAL_ABI, functionName:'balanceOf', args:[a] }), 6);

async function send(label, params) {
  try {
    const hash = await wc.writeContract(params);
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label.padEnd(28)} ${hash.slice(0,18)}…  gas ${r.gasUsed}  ${r.status}`);
  } catch (e) {
    console.log(`  ${label.padEnd(28)} ✗  ${e.shortMessage || e.message}`);
  }
}

(async () => {
  console.log('━━━ Before ━━━');
  console.log('  AC  :', await bal(AC));
  console.log('  Hook:', await bal(HOOK));

  console.log('\n━━━ Path B: refundFee(6) ━━━');
  await send('refundFee(6)', { address: HOOK, abi: HOOK_ABI, functionName: 'refundFee', args: [6n] });

  console.log('\n━━━ Orphan job 4: claim + refund ━━━');
  await send('claimRefund(4)', { address: AC, abi: AC_ABI, functionName: 'claimRefund', args: [4n] });
  await send('refundFee(4)',   { address: HOOK, abi: HOOK_ABI, functionName: 'refundFee', args: [4n] });

  console.log('\n━━━ After ━━━');
  console.log('  AC  :', await bal(AC), '(expected 0)');
  console.log('  Hook:', await bal(HOOK), '(expected 0)');

  console.log('\n━━━ Per-job ━━━');
  const counter = await pub.readContract({ address: AC, abi: AC_ABI, functionName: 'jobCounter' });
  for (let i = 1n; i <= counter; i++) {
    const j  = await pub.readContract({ address: AC, abi: AC_ABI, functionName: 'getJob', args: [i] });
    const fm = await pub.readContract({ address: HOOK, abi: HOOK_ABI, functionName: 'getFeeMeta', args: [i] });
    const feeTag = fm.feeDeposited ? (fm.feeSettled ? 'fee:settled' : 'fee:UNSETTLED') : 'fee:none';
    console.log(`  Job ${i}: ${STATUS[j.status].padEnd(10)} ${feeTag}`);
  }
})().catch(e => { console.error('FAIL', e?.shortMessage || e?.message || e); process.exit(1); });
