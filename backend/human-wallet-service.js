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

export function buildHumanProfileTransactions({
  username,
  metadataURI,
  profileType = 0,
}) {
  return {
    create: buildCreateProfileCalldata({ username, metadataURI, profileType }),
    update: buildUpdateProfileCalldata({ metadataURI }),
  };
}

export function buildHumanProfileMetadataURI({
  username,
  displayName = '',
  profileType = 'human',
  bio = '',
  ecosystems = [],
  wallet,
  farcaster = '',
  github = '',
  x = '',
  discord = '',
  linkedin = '',
  pfp = '',
}) {
  const metadata = {
    username,
    display_name: displayName,
    profile_type: profileType === 'agent' ? 'agent' : 'human',
    bio,
    ecosystems: Array.isArray(ecosystems) ? ecosystems : [],
    wallet,
    farcaster: farcaster || undefined,
    github: github || undefined,
    x: x || undefined,
    discord: discord || undefined,
    linkedin: linkedin || undefined,
    pfp: pfp || undefined,
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
}

export async function prepareHumanProfileTransaction(address, profile) {
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
  const transactions = buildHumanProfileTransactions(profile);
  return {
    exists,
    transaction: exists ? transactions.update : transactions.create,
    acceptedData: [transactions.create.data, transactions.update.data],
  };
}

export async function createOrUpdateHumanProfile(address, profile) {
  const { exists, transaction } = await prepareHumanProfileTransaction(address, profile);
  return onchainEscrow.sendAs(
    address,
    transaction,
    exists ? 'human-profile-update' : 'human-profile-create',
  );
}

export function buildHumanUsdcTransfer(recipient, amount, {
  maxAmount = 100,
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
  return {
    to: USDC_ADDRESS,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [recipient, amountWei],
    }),
  };
}

export async function prepareHumanUsdcTransfer(address, recipient, amount, options = {}) {
  const transaction = buildHumanUsdcTransfer(recipient, amount, options);
  const amountWei = parseUnits(String(amount), 6);
  const balance = await onchainEscrow.usdcBalance(address);
  if (balance < amountWei) {
    throw Object.assign(new Error('Insufficient USDC balance'), { status: 409 });
  }
  return transaction;
}

export function validateExternalTransactionDetails({
  receipt,
  transaction,
  expectedFrom,
  expectedTo,
  acceptedData,
  expectedValue = 0n,
}) {
  if (!receipt || receipt.status !== 'success') {
    return { valid: false, error: 'Transaction is not confirmed successfully on Arc' };
  }
  if (transaction.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { valid: false, error: 'Transaction was not signed by your connected wallet' };
  }
  if (transaction.to?.toLowerCase() !== expectedTo.toLowerCase()) {
    return { valid: false, error: 'Transaction target does not match the requested BARD action' };
  }
  if (BigInt(transaction.value || 0n) !== BigInt(expectedValue)) {
    return { valid: false, error: 'Transaction value does not match the requested BARD action' };
  }
  const data = String(transaction.input || transaction.data || '0x').toLowerCase();
  const allowed = (Array.isArray(acceptedData) ? acceptedData : [acceptedData])
    .map((value) => String(value || '0x').toLowerCase());
  if (!allowed.includes(data)) {
    return { valid: false, error: 'Transaction calldata does not match the requested BARD action' };
  }
  return { valid: true };
}

async function transferHumanUsdc(address, recipient, amount, {
  maxAmount = 100,
  label = 'human-send-usdc',
} = {}) {
  const transaction = await prepareHumanUsdcTransfer(address, recipient, amount, {
    maxAmount,
  });
  return onchainEscrow.sendAs(address, transaction, label);
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

export function buildHumanProofTransaction({
  title,
  description = '',
  ecosystem = '',
  contributionType = 'other',
  externalLink = '',
}) {
  if (!title?.trim()) throw Object.assign(new Error('Proof title required'), { status: 400 });
  return {
    to: BARD_PROOF_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PROOF_ABI,
      functionName: 'submitProof',
      args: [title.trim(), description, ecosystem, contributionType, externalLink],
    }),
  };
}

export async function submitHumanProof(address, proof) {
  return onchainEscrow.sendAs(
    address,
    buildHumanProofTransaction(proof),
    'human-submit-proof',
  );
}

export function buildHumanVouchTransactions({
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
  const tierNumber = Number(tier);
  if (!Number.isInteger(tierNumber) || tierNumber < 0 || tierNumber > 3) {
    throw Object.assign(new Error('Vouch tier must be between 0 and 3'), { status: 400 });
  }
  const scoreNumber = Number(score);
  if (!Number.isInteger(scoreNumber) || scoreNumber < 0 || scoreNumber > 100) {
    throw Object.assign(new Error('Vouch score must be an integer between 0 and 100'), { status: 400 });
  }
  const stakeAmount = parseUnits(String(amount), 6);
  return {
    approve: {
      to: USDC_ADDRESS,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [BARD_VOUCH_ADDRESS, stakeAmount],
      }),
    },
    vouch: buildVouchCalldata({
      contributorId: BigInt(contributorWallet),
      stakeAmount,
      tier: tierNumber,
      statement,
      ecosystem,
      evidenceURI,
      score: BigInt(scoreNumber),
    }),
    stakeAmount,
  };
}

export async function prepareHumanVouchTransactions(address, input) {
  const transactions = buildHumanVouchTransactions(input);
  const balance = await onchainEscrow.usdcBalance(address);
  if (balance < transactions.stakeAmount) {
    throw Object.assign(new Error('Insufficient USDC balance'), { status: 409 });
  }
  return transactions;
}

export async function createHumanVouch(address, input) {
  const transactions = await prepareHumanVouchTransactions(address, input);
  const approve = await onchainEscrow.sendAs(
    address,
    transactions.approve,
    'human-vouch-approve'
  );

  const vouch = await onchainEscrow.sendAs(
    address,
    transactions.vouch,
    'human-vouch'
  );

  return { approveTxHash: approve.txHash, txHash: vouch.txHash };
}
