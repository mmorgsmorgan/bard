/**
 * erc8183-client.js — backend SDK for BARD's on-chain escrow.
 *
 * Wraps the ERC-8183 (AgenticCommerce) + BardJobHook deployment on Arc Testnet.
 * The current server.js is custodial (Turnkey signs all payouts); this module
 * is the bridge for migrating to per-bounty on-chain escrow.
 *
 * Scope of this sketch:
 *   - Exported ABIs for both contracts.
 *   - A shared viem public client for reads.
 *   - Read helpers (getJob, getFeeMeta, status decoding).
 *   - Calldata builders for every lifecycle action.
 *
 * Out of scope (handled by the caller):
 *   - Signing. The caller chooses which wallet signs which leg — typically
 *     Turnkey for the platform's evaluator + treasury, user wallets for
 *     client + provider.
 *   - Permits / 2612. Layer permits on top of `buildFundCalldata` once your
 *     wallet flow supports them.
 *   - DB synchronization. The migration plan is to dual-write on-chain id +
 *     status into the existing bounties table during a transition window.
 */

import { createPublicClient, http, encodeFunctionData, keccak256, toBytes } from 'viem';
export { withMemo, MemoIds, ARC_MEMO_ADDRESS, encodeMemoData, decodeMemoData, memoLogFilter } from './arc-memo.js';

// ──────────────────────────────────────────────
//  Chain & address config
// ──────────────────────────────────────────────

const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID = 5042002;

export const ARC_TESTNET = {
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] }, public: { http: [ARC_RPC] } },
};

// Set these via env once the contracts are deployed.
export const AGENTIC_COMMERCE_ADDRESS =
  process.env.AGENTIC_COMMERCE_ADDRESS || '0x0000000000000000000000000000000000000000';
export const BARD_JOB_HOOK_ADDRESS =
  process.env.BARD_JOB_HOOK_ADDRESS || '0x0000000000000000000000000000000000000000';
export const USDC_ADDRESS =
  process.env.USDC_CONTRACT_ADDRESS || '0x3600000000000000000000000000000000000000';

export const publicClient = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(ARC_RPC),
});

// ──────────────────────────────────────────────
//  ABIs (minimal — only what the backend touches)
// ──────────────────────────────────────────────

export const ERC8183_ABI = [
  {
    type: 'function',
    name: 'createJob',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint48' },
      { name: 'description', type: 'string' },
      { name: 'hook', type: 'address' },
      { name: 'providerAgentId', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setProvider',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'provider', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setBudget',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'expectedBudget', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'complete',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reject',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'client', type: 'address' },
          { name: 'status', type: 'uint8' },
          { name: 'provider', type: 'address' },
          { name: 'expiredAt', type: 'uint48' },
          { name: 'evaluator', type: 'address' },
          { name: 'submittedAt', type: 'uint48' },
          { name: 'budget', type: 'uint256' },
          { name: 'hook', type: 'address' },
          { name: 'paymentToken', type: 'address' },
          { name: 'providerAgentId', type: 'uint256' },
          { name: 'description', type: 'string' },
        ],
      },
    ],
  },
];

export const BARD_JOB_HOOK_ABI = [
  {
    type: 'function',
    name: 'configureBardJob',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'platformFee', type: 'uint128' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'maxFeeBps', type: 'uint16' },
      { name: 'minRepScore', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getFeeMeta',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'platformFee', type: 'uint128' },
          { name: 'feeRecipient', type: 'address' },
          { name: 'maxFeeBps', type: 'uint16' },
          { name: 'minRepScore', type: 'uint16' },
          { name: 'configured', type: 'bool' },
          { name: 'feeDeposited', type: 'bool' },
          { name: 'feeSettled', type: 'bool' },
        ],
      },
    ],
  },
];

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

// ──────────────────────────────────────────────
//  Status enum mirror
// ──────────────────────────────────────────────

export const JobStatus = Object.freeze({
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
});

export const JobStatusName = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];

// ──────────────────────────────────────────────
//  Reads
// ──────────────────────────────────────────────

export async function getJob(jobId) {
  return publicClient.readContract({
    address: AGENTIC_COMMERCE_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  });
}

export async function getFeeMeta(jobId) {
  return publicClient.readContract({
    address: BARD_JOB_HOOK_ADDRESS,
    abi: BARD_JOB_HOOK_ABI,
    functionName: 'getFeeMeta',
    args: [BigInt(jobId)],
  });
}

// ──────────────────────────────────────────────
//  Calldata builders
//  Use these to build raw txs that the caller signs through Turnkey / user wallet.
// ──────────────────────────────────────────────

/// Hash a UTF-8 string for use as `deliverable` / `reason` bytes32 fields.
export function hashTag(label) {
  return keccak256(toBytes(label));
}

export function buildCreateJobCalldata({
  provider,
  evaluator,
  expiredAt,
  description,
  providerAgentId = 0n,
  hook = BARD_JOB_HOOK_ADDRESS,
}) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'createJob',
      args: [
        provider ?? '0x0000000000000000000000000000000000000000',
        evaluator,
        BigInt(expiredAt),
        description,
        hook,
        BigInt(providerAgentId),
      ],
    }),
  };
}

export function buildConfigureBardJobCalldata({
  jobId,
  platformFee,
  feeRecipient,
  maxFeeBps,
  minRepScore = 0,
}) {
  return {
    to: BARD_JOB_HOOK_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_JOB_HOOK_ABI,
      functionName: 'configureBardJob',
      args: [BigInt(jobId), BigInt(platformFee), feeRecipient, maxFeeBps, minRepScore],
    }),
  };
}

export function buildSetProviderCalldata({ jobId, provider, agentId = 0n }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'setProvider',
      args: [BigInt(jobId), provider, BigInt(agentId)],
    }),
  };
}

export function buildSetBudgetCalldata({ jobId, amount, token = USDC_ADDRESS, optParams = '0x' }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'setBudget',
      args: [BigInt(jobId), token, BigInt(amount), optParams],
    }),
  };
}

export function buildApproveCalldata({ spender, amount, token = USDC_ADDRESS }) {
  return {
    to: token,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, BigInt(amount)],
    }),
  };
}

export function buildDepositFeeCalldata({ jobId }) {
  return {
    to: BARD_JOB_HOOK_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_JOB_HOOK_ABI,
      functionName: 'depositFee',
      args: [BigInt(jobId)],
    }),
  };
}

export function buildFundCalldata({ jobId, expectedBudget, optParams = '0x' }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'fund',
      args: [BigInt(jobId), BigInt(expectedBudget), optParams],
    }),
  };
}

export function buildSubmitCalldata({ jobId, deliverable, optParams = '0x' }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'submit',
      args: [BigInt(jobId), deliverable, optParams],
    }),
  };
}

export function buildCompleteCalldata({ jobId, reason, optParams = '0x' }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'complete',
      args: [BigInt(jobId), reason, optParams],
    }),
  };
}

export function buildRejectCalldata({ jobId, reason, optParams = '0x' }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'reject',
      args: [BigInt(jobId), reason, optParams],
    }),
  };
}

export function buildClaimRefundCalldata({ jobId }) {
  return {
    to: AGENTIC_COMMERCE_ADDRESS,
    data: encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: 'claimRefund',
      args: [BigInt(jobId)],
    }),
  };
}

export function buildRefundFeeCalldata({ jobId }) {
  return {
    to: BARD_JOB_HOOK_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_JOB_HOOK_ABI,
      functionName: 'refundFee',
      args: [BigInt(jobId)],
    }),
  };
}

// ──────────────────────────────────────────────
//  Event signatures (for log-watching)
// ──────────────────────────────────────────────

export const EventSigs = Object.freeze({
  // ERC-8183
  JobCreated: keccak256(toBytes('JobCreated(uint256,address,address,address,uint48,address)')),
  JobFunded: keccak256(toBytes('JobFunded(uint256,address,uint256)')),
  JobSubmitted: keccak256(toBytes('JobSubmitted(uint256,address,bytes32)')),
  JobCompleted: keccak256(toBytes('JobCompleted(uint256,address,bytes32)')),
  JobRejected: keccak256(toBytes('JobRejected(uint256,address,bytes32)')),
  JobExpired: keccak256(toBytes('JobExpired(uint256)')),
  // BardJobHook
  BardJobConfigured: keccak256(
    toBytes('BardJobConfigured(uint256,uint128,address,uint16,uint16)'),
  ),
  BardFeeDeposited: keccak256(toBytes('BardFeeDeposited(uint256,address,uint128)')),
  BardFeeReleased: keccak256(toBytes('BardFeeReleased(uint256,address,uint128)')),
  BardFeeRefunded: keccak256(toBytes('BardFeeRefunded(uint256,address,uint128,uint8)')),
});
