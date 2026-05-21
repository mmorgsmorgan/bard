import { defineChain } from 'viem';

/**
 * Arc Testnet chain definition for Viem/Wagmi.
 * USDC is the native gas token (not ETH).
 */
export const arcTestnet = defineChain({
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arc Explorer',
      url: 'https://explorer.testnet.arc.network',
    },
  },
  testnet: true,
});

// ── Contract Addresses (Arc Testnet) ──

export const CONTRACTS = {
  // Arc ERC-8004 native contracts
  IDENTITY_REGISTRY: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as `0x${string}`,
  REPUTATION_REGISTRY: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as `0x${string}`,
  VALIDATION_REGISTRY: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272' as `0x${string}`,
  
  // Stablecoins
  USDC: '0x3600000000000000000000000000000000000000' as `0x${string}`,

  // BARD custom contracts (deployed on Arc Testnet — fresh deploy with fixes)
  BARD_PROFILE: '0xF3c829d3b732C248b7Df3d096e76dB7B93CdFee8' as `0x${string}`,
  BARD_VOUCH: '0x12d15a888B6Fb235C49e71CaaD7F999f780808BA' as `0x${string}`,
  BARD_BADGE: '0x46B477583E10595315d135ca6ac026D577dA68a8' as `0x${string}`,
  BARD_PFP: '0xCCa07Df7cf085Af0c5dcBc5494ca716409C42aA6' as `0x${string}`,
  BARD_PROOF: '0xE9EB738fBb264c98C0F34D12fD238e32D5997D2b' as `0x${string}`,
  BARD_AGENT: '0x0d09e4299c90AA685108b6311acEF2a60A4d274c' as `0x${string}`,

} as const;

// Backend API
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// ── Vouch Tiers ──

export const VOUCH_TIERS = [
  { id: 0, name: 'Micro',    minUSDC: 1,   multiplier: '0.5×', color: 'tier-micro',    description: 'Low-stake endorsement for newcomers' },
  { id: 1, name: 'Standard', minUSDC: 10,  multiplier: '1.0×', color: 'tier-standard',  description: 'General ecosystem vouching' },
  { id: 2, name: 'Endorsed', minUSDC: 100, multiplier: '1.5×', color: 'tier-endorsed',  description: 'High-trust ecosystem lead validation' },
  { id: 3, name: 'Founder',  minUSDC: 500, multiplier: '2.0×', color: 'tier-founder',   description: 'Project founder / core team validation' },
] as const;

// ── Contribution Types ──

export const CONTRIBUTION_TYPES = [
  'design',
  'development',
  'moderation',
  'governance',
  'research',
  'community',
  'content',
  'operations',
] as const;

export type ContributionType = typeof CONTRIBUTION_TYPES[number];

// ── Profile Types ──

export const PROFILE_TYPES = ['human', 'agent'] as const;
export type ProfileType = typeof PROFILE_TYPES[number];
