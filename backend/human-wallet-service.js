import { encodeFunctionData, parseUnits } from 'viem';
import * as onchainEscrow from './escrow-service.js';
import {
  BARD_PROFILE_ADDRESS,
  BARD_VOUCH_ADDRESS,
  buildCreateProfileCalldata,
  buildUpdateProfileCalldata,
  buildVouchCalldata,
} from './bard-writes-client.js';

const USDC_ADDRESS =
  process.env.USDC_CONTRACT_ADDRESS || '0x3600000000000000000000000000000000000000';
const BARD_PROOF_ADDRESS =
  process.env.BARD_PROOF_ADDRESS || '0xe9eb738fbb264c98c0f34d12fd238e32d5997d2b';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

const BARD_PROFILE_READ_ABI = [{
  type: 'function',
  name: 'profileExists',
  stateMutability: 'view',
  inputs: [{ name: 'wallet', type: 'address' }],
  outputs: [{ name: '', type: 'bool' }],
}];

const BARD_PROOF_ABI = [{
  type: 'function',
  name: 'submitProof',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'ecosystem', type: 'string' },
    { name: 'contributionType', type: 'string' },
    { name: 'externalLink', type: 'string' },
  ],
  outputs: [],
}];

function validAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address || '');
}

export async function humanWalletBalance(address) {
  const [usdc, native] = await Promise.all([
    onchainEscrow.usdcBalance(address),
    onchainEscrow.nativeBalance(address),
  ]);
  return {
    address,
    balanceUsdc: onchainEscrow.fromUsdcWei(usdc).toFixed(6),
    nativeGasBalanceWei: native.toString(),
    explorer: `https://testnet.arcscan.app/address/${address}`,
  };
}

export async function createOrUpdateHumanProfile(address, {
  username,
  metadataURI,
  profileType = 0,
}) {
  const exists = await onchainEscrow.withArcRpcRetry(
    () => import('./erc8183-client.js').then(({ publicClient }) => (
      publicClient.readContract({
        address: BARD_PROFILE_ADDRESS,
        abi: BARD_PROFILE_READ_ABI,
        functionName: 'profileExists',
        args: [address],
      })
    )),
    { label: `BARD profile lookup for ${address}` },
  );
  const tx = exists
    ? buildUpdateProfileCalldata({ metadataURI })
    : buildCreateProfileCalldata({ username, metadataURI, profileType });
  return onchainEscrow.sendAs(
    address,
    tx,
    exists ? 'human-profile-update' : 'human-profile-create',
  );
}

async function transferHumanUsdc(address, recipient, amount, {
  maxAmount = 100,
  label = 'human-send-usdc',
} = {}) {
  if (!validAddress(recipient)) throw Object.assign(new Error('Valid recipient required'), { status: 400 });
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0 || amountNumber > maxAmount) {
    throw Object.assign(
      new Error(`Amount must be greater than 0 and at most ${maxAmount} USDC`),
      { status: 400 }
    );
  }
  const amountWei = parseUnits(String(amount), 6);
  const balance = await onchainEscrow.usdcBalance(address);
  if (balance < amountWei) {
    throw Object.assign(new Error('Insufficient USDC balance'), { status: 409 });
  }
  return onchainEscrow.sendAs(address, {
    to: USDC_ADDRESS,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [recipient, amountWei],
    }),
  }, label);
}

export async function sendHumanUsdc(address, recipient, amount) {
  return transferHumanUsdc(address, recipient, amount);
}

export async function fundManagedEscrow(address, escrowAddress, amount) {
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber < 1) {
    throw Object.assign(new Error('Bounty funding must be at least 1 USDC'), { status: 400 });
  }
  return transferHumanUsdc(address, escrowAddress, amount, {
    maxAmount: 10_000,
    label: 'managed-fund-bounty',
  });
}

export const fundHumanEscrow = fundManagedEscrow;

export async function submitHumanProof(address, {
  title,
  description = '',
  ecosystem = '',
  contributionType = 'other',
  externalLink = '',
}) {
  if (!title?.trim()) throw Object.assign(new Error('Proof title required'), { status: 400 });
  return onchainEscrow.sendAs(address, {
    to: BARD_PROOF_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PROOF_ABI,
      functionName: 'submitProof',
      args: [title.trim(), description, ecosystem, contributionType, externalLink],
    }),
  }, 'human-submit-proof');
}

export async function createHumanVouch(address, {
  contributorWallet,
  amount,
  tier = 0,
  statement = '',
  ecosystem = '',
  evidenceURI = '',
  score = 80,
}) {
  if (!validAddress(contributorWallet)) {
    throw Object.assign(new Error('Valid contributor wallet required'), { status: 400 });
  }
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    throw Object.assign(new Error('Vouch amount must be greater than 0'), { status: 400 });
  }
  const stakeAmount = parseUnits(String(amount), 6);
  const balance = await onchainEscrow.usdcBalance(address);
  if (balance < stakeAmount) {
    throw Object.assign(new Error('Insufficient USDC balance'), { status: 409 });
  }

  const approve = await onchainEscrow.sendAs(address, {
    to: USDC_ADDRESS,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [BARD_VOUCH_ADDRESS, stakeAmount],
    }),
  }, 'human-vouch-approve');

  const vouch = await onchainEscrow.sendAs(address, buildVouchCalldata({
    contributorId: BigInt(contributorWallet),
    stakeAmount,
    tier: Number(tier),
    statement,
    ecosystem,
    evidenceURI,
    score: BigInt(score),
  }), 'human-vouch');

  return { approveTxHash: approve.txHash, txHash: vouch.txHash };
}
