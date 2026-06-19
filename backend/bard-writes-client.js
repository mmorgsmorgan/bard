/**
 * bard-writes-client.js — calldata builders for BARD's non-escrow on-chain writes.
 *
 * Pairs with `arc-memo.js` so every write can be optionally wrapped with a memo:
 *
 *   const inner = buildBardVouchCalldata({ contributorId, stakeAmount, ... });
 *   const wrapped = withMemo(inner, {
 *     memoId: MemoIds.VouchCast,
 *     memoData: { contributorWallet, voucherWallet, ecosystem },
 *   });
 *
 * The wrapped tx targets the Memo contract; the inner target (BardVouch, etc.)
 * still sees the EOA as msg.sender via Arc's CallFrom precompile.
 */

import { encodeFunctionData } from 'viem';

// ──────────────────────────────────────────────
//  Deployed addresses (Arc Testnet) — override via env in production.
// ──────────────────────────────────────────────

export const BARD_PROFILE_ADDRESS =
  process.env.BARD_PROFILE_ADDRESS || '0xf3c829d3b732c248b7df3d096e76db7b93cdfee8';
export const BARD_VOUCH_ADDRESS =
  process.env.BARD_VOUCH_ADDRESS || '0x12d15a888b6fb235c49e71caad7f999f780808ba';
export const BARD_PFP_ADDRESS =
  process.env.BARD_PFP_ADDRESS || '0x0000000000000000000000000000000000000000';
export const IDENTITY_REGISTRY_ADDRESS =
  process.env.IDENTITY_REGISTRY_ADDRESS || '0x8004A818BFB912233c491871b3d84c89A494BD9e';

// ──────────────────────────────────────────────
//  ABI fragments (write functions only)
// ──────────────────────────────────────────────

export const BARD_PROFILE_ABI = [
  {
    type: 'function',
    name: 'createProfile',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'username', type: 'string' },
      { name: 'metadataURI', type: 'string' },
      { name: 'profileType', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateProfile',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newMetadataURI', type: 'string' }],
    outputs: [],
  },
];

export const BARD_VOUCH_ABI = [
  {
    type: 'function',
    name: 'vouch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contributorId', type: 'uint256' },
      { name: 'stakeAmount', type: 'uint256' },
      { name: 'tier', type: 'uint8' },
      { name: 'statement', type: 'string' },
      { name: 'ecosystem', type: 'string' },
      { name: 'evidenceURI', type: 'string' },
      { name: 'score', type: 'int128' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawStake',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contributorId', type: 'uint256' },
      { name: 'vouchIndex', type: 'uint256' },
    ],
    outputs: [],
  },
];

export const BARD_PFP_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updatePFP',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newTokenURI', type: 'string' }],
    outputs: [],
  },
];

export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'metadataURI', type: 'string' }],
    outputs: [],
  },
];

// ──────────────────────────────────────────────
//  Profile types (mirror of BardProfile.ProfileType enum)
// ──────────────────────────────────────────────

export const ProfileType = Object.freeze({
  Human: 0,
  Agent: 1,
  Swarm: 2,
});

// ──────────────────────────────────────────────
//  Vouch tiers (mirror of BardVouch.VouchTier enum)
// ──────────────────────────────────────────────

export const VouchTier = Object.freeze({
  Bronze: 0,
  Silver: 1,
  Gold: 2,
});

// ──────────────────────────────────────────────
//  BardProfile builders
// ──────────────────────────────────────────────

export function buildCreateProfileCalldata({ username, metadataURI, profileType }) {
  return {
    to: BARD_PROFILE_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PROFILE_ABI,
      functionName: 'createProfile',
      args: [username, metadataURI, profileType],
    }),
  };
}

export function buildUpdateProfileCalldata({ metadataURI }) {
  return {
    to: BARD_PROFILE_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PROFILE_ABI,
      functionName: 'updateProfile',
      args: [metadataURI],
    }),
  };
}

// ──────────────────────────────────────────────
//  BardVouch builders
// ──────────────────────────────────────────────

export function buildVouchCalldata({
  contributorId,
  stakeAmount,
  tier,
  statement,
  ecosystem,
  evidenceURI,
  score,
}) {
  return {
    to: BARD_VOUCH_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_VOUCH_ABI,
      functionName: 'vouch',
      args: [
        BigInt(contributorId),
        BigInt(stakeAmount),
        tier,
        statement,
        ecosystem,
        evidenceURI,
        BigInt(score),
      ],
    }),
  };
}

export function buildWithdrawStakeCalldata({ contributorId, vouchIndex }) {
  return {
    to: BARD_VOUCH_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_VOUCH_ABI,
      functionName: 'withdrawStake',
      args: [BigInt(contributorId), BigInt(vouchIndex)],
    }),
  };
}

// ──────────────────────────────────────────────
//  BardPFP builders
// ──────────────────────────────────────────────

export function buildPfpMintCalldata({ tokenURI }) {
  return {
    to: BARD_PFP_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PFP_ABI,
      functionName: 'mint',
      args: [tokenURI],
    }),
  };
}

export function buildPfpUpdateCalldata({ tokenURI }) {
  return {
    to: BARD_PFP_ADDRESS,
    data: encodeFunctionData({
      abi: BARD_PFP_ABI,
      functionName: 'updatePFP',
      args: [tokenURI],
    }),
  };
}

// ──────────────────────────────────────────────
//  ERC-8004 Identity Registry
// ──────────────────────────────────────────────

export function buildIdentityRegisterCalldata({ metadataURI }) {
  return {
    to: IDENTITY_REGISTRY_ADDRESS,
    data: encodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'register',
      args: [metadataURI],
    }),
  };
}
