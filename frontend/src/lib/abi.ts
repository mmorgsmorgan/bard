/**
 * Contract ABIs for BARD — extracted from compiled Solidity.
 * Only includes the functions/events the frontend needs.
 */

// ── Arc ERC-8004 Identity Registry ──
export const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'metadataURI', type: 'string' }],
    outputs: [],
  },
  {
    name: 'isRegistered',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const BARD_PROFILE_ABI = [
  // Write
  {
    name: 'createProfile',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'username', type: 'string' },
      { name: 'metadataURI', type: 'string' },
      { name: 'profileType', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    name: 'updateProfile',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newMetadataURI', type: 'string' }],
    outputs: [],
  },
  // Read
  {
    name: 'profiles',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      { name: 'wallet', type: 'address' },
      { name: 'username', type: 'string' },
      { name: 'metadataURI', type: 'string' },
      { name: 'profileType', type: 'uint8' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    name: 'profileExists',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'usernameExists',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'username', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'usernameToWallet',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'username', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'totalProfiles',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getProfile',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'wallet', type: 'address' },
          { name: 'username', type: 'string' },
          { name: 'metadataURI', type: 'string' },
          { name: 'profileType', type: 'uint8' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'exists', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'getProfileByUsername',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'username', type: 'string' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'wallet', type: 'address' },
          { name: 'username', type: 'string' },
          { name: 'metadataURI', type: 'string' },
          { name: 'profileType', type: 'uint8' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'exists', type: 'bool' },
        ],
      },
    ],
  },
  // Events
  {
    name: 'ProfileCreated',
    type: 'event',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'username', type: 'string', indexed: false },
      { name: 'profileType', type: 'uint8', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const BARD_VOUCH_ABI = [
  // Write
  {
    name: 'vouch',
    type: 'function',
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
    name: 'withdrawStake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contributorId', type: 'uint256' },
      { name: 'vouchIndex', type: 'uint256' },
    ],
    outputs: [],
  },
  // Read
  {
    name: 'totalVouches',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalStaked',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getVouchCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'contributorId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getTotalInfluence',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'contributorId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalStakedForContributor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'contributorId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Events
  {
    name: 'VouchCreated',
    type: 'event',
    inputs: [
      { name: 'voucher', type: 'address', indexed: true },
      { name: 'contributorId', type: 'uint256', indexed: true },
      { name: 'stakedAmount', type: 'uint256', indexed: false },
      { name: 'influence', type: 'uint256', indexed: false },
      { name: 'tier', type: 'uint8', indexed: false },
      { name: 'ecosystem', type: 'string', indexed: false },
      { name: 'lockExpiry', type: 'uint256', indexed: false },
      { name: 'vouchIndex', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const BARD_PFP_ABI = [
  // Write
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [],
  },
  {
    name: 'updatePFP',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newTokenURI', type: 'string' }],
    outputs: [],
  },
  // Read
  {
    name: 'getPFP',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'hasPFP',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'getChangeAvailableAt',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Events
  {
    name: 'PFPMinted',
    type: 'event',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: false },
      { name: 'tokenURI', type: 'string', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const BARD_PROOF_ABI = [
  // Write
  {
    name: 'submitProof',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'ecosystem', type: 'string' },
      { name: 'contributionType', type: 'string' },
      { name: 'externalLink', type: 'string' },
    ],
    outputs: [],
  },
  // Read
  {
    name: 'getProofsByContributor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'contributor', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'contributor', type: 'address' },
          { name: 'title', type: 'string' },
          { name: 'description', type: 'string' },
          { name: 'ecosystem', type: 'string' },
          { name: 'contributionType', type: 'string' },
          { name: 'externalLink', type: 'string' },
          { name: 'status', type: 'uint8' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'getContributorProofCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'contributor', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalProofs',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Events
  {
    name: 'ProofSubmitted',
    type: 'event',
    inputs: [
      { name: 'contributor', type: 'address', indexed: true },
      { name: 'proofId', type: 'uint256', indexed: true },
      { name: 'title', type: 'string', indexed: false },
      { name: 'ecosystem', type: 'string', indexed: false },
      { name: 'contributionType', type: 'string', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const BARD_AGENT_ABI = [
  // Write
  {
    name: 'registerAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'apiEndpoint', type: 'string' },
      { name: 'capabilities', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'recordAction',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'actionType', type: 'string' },
      { name: 'data', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'updateAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newOperator', type: 'address' },
      { name: 'newEndpoint', type: 'string' },
      { name: 'newCapabilities', type: 'string' },
    ],
    outputs: [],
  },
  // Read
  {
    name: 'getAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'wallet', type: 'address' },
          { name: 'operator', type: 'address' },
          { name: 'apiEndpoint', type: 'string' },
          { name: 'capabilities', type: 'string' },
          { name: 'registeredAt', type: 'uint256' },
          { name: 'proofsSubmitted', type: 'uint256' },
          { name: 'lastActiveAt', type: 'uint256' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'isAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'totalAgents',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Events
  {
    name: 'AgentRegistered',
    type: 'event',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'apiEndpoint', type: 'string', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
] as const;
