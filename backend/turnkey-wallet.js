/**
 * Turnkey Company Wallet Service
 *
 * Manages Turnkey-hosted wallets for BARD agents.
 * Each agent gets a Turnkey wallet that can sign on-chain transactions
 * (e.g. ERC-8004 IdentityRegistry.register) on Arc Testnet.
 *
 * Free tier: 100 wallets, 25 signatures/month
 */

import { Turnkey } from '@turnkey/sdk-server';
import { createAccount } from '@turnkey/viem';
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem';

// ── Arc Testnet Chain Definition ──
// Arc uses stablecoins (USDC) as gas, not ETH
const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
};

// ── ERC-8004 Contract Addresses ──
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

// Minimal ABI for register(string)
const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'metadataURI', type: 'string' }],
    outputs: [],
  },
];

// ── Turnkey Client ──
let turnkeyClient = null;

function getTurnkey() {
  if (turnkeyClient) return turnkeyClient;

  const orgId = process.env.TURNKEY_ORGANIZATION_ID;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;

  if (!orgId || !apiPrivateKey || !apiPublicKey) {
    return null; // Turnkey not configured — gracefully degrade
  }

  turnkeyClient = new Turnkey({
    defaultOrganizationId: orgId,
    apiBaseUrl: 'https://api.turnkey.com',
    apiPrivateKey,
    apiPublicKey,
  });

  return turnkeyClient;
}

/**
 * Check if Turnkey is configured and available
 */
export function isTurnkeyEnabled() {
  return !!getTurnkey();
}

/**
 * Create a Turnkey wallet for an agent. Idempotent — if a previous attempt
 * succeeded in Turnkey but failed before the DB record landed, this finds
 * the orphaned wallet by its deterministic name and adopts it.
 *
 * Returns { walletId, address } on success.
 * Returns { error, detail, code } on Turnkey API failure the caller can't
 *   resolve (the caller decides whether to surface or log).
 * Returns null only when Turnkey is unconfigured.
 */
export async function createAgentWallet(agentId, agentName) {
  const tk = getTurnkey();
  if (!tk) return null;

  const apiClient = tk.apiClient();
  const walletName = `bard-agent-${agentId}`;

  try {
    const walletResponse = await apiClient.createWallet({
      walletName,
      accounts: [
        {
          curve: 'CURVE_SECP256K1',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/60'/0'/0/0",
          addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
        },
      ],
    });

    const walletId = walletResponse.walletId;
    const address = walletResponse.addresses?.[0];
    console.log(`  Turnkey wallet created for agent ${agentName}: ${address}`);
    return { walletId, address };
  } catch (err) {
    const msg = err?.message || String(err);

    // Idempotency recovery: a previous run created the wallet in Turnkey
    // but failed before the DB UPDATE persisted turnkey_wallet_id /
    // turnkey_address. Subsequent attempts hit "wallet label must be
    // unique." Look up the existing wallet by its deterministic name and
    // adopt it — the caller will then write the row.
    if (/wallet label must be unique/i.test(msg) || err?.code === 3) {
      try {
        const orgId = process.env.TURNKEY_ORGANIZATION_ID;
        const { wallets } = await apiClient.getWallets({ organizationId: orgId });
        const match = wallets.find((w) => w.walletName === walletName);
        if (match) {
          const { accounts } = await apiClient.getWalletAccounts({
            organizationId: orgId,
            walletId: match.walletId,
          });
          const addr = accounts?.[0]?.address;
          if (addr) {
            console.log(`  Turnkey wallet recovered (adopted orphan) for ${agentName}: ${addr}`);
            return { walletId: match.walletId, address: addr };
          }
        }
        // Unique-name collision but couldn't find the matching wallet —
        // pass through the original error so the caller sees something.
      } catch (recoveryErr) {
        console.error(`  Turnkey orphan-recovery failed for ${agentName}:`, recoveryErr.message);
      }
    }

    console.error(`  Turnkey wallet creation failed for ${agentName}:`, msg);
    return {
      error: 'turnkey_create_wallet_failed',
      detail: msg,
      code: err?.code,
    };
  }
}

/**
 * Get or create a Turnkey wallet for an agent.
 * Checks the DB first; creates one if missing.
 *
 * `db` is the pg Pool exported from ./db.js.
 */
export async function getOrCreateAgentWallet(db, agentId, agentName) {
  // Check if agent already has a Turnkey wallet
  const { rows } = await db.query(
    'SELECT turnkey_wallet_id, turnkey_address FROM agents WHERE id = $1',
    [agentId]
  );
  const agent = rows[0];

  if (agent?.turnkey_wallet_id && agent?.turnkey_address) {
    return { walletId: agent.turnkey_wallet_id, address: agent.turnkey_address };
  }

  // Create new wallet
  const wallet = await createAgentWallet(agentId, agentName);
  if (!wallet) return null;                  // Turnkey not configured
  if (wallet.error) return wallet;           // Turnkey API failed — pass through

  // Store in DB
  await db.query(
    'UPDATE agents SET turnkey_wallet_id = $1, turnkey_address = $2 WHERE id = $3',
    [wallet.walletId, wallet.address, agentId]
  );

  return wallet;
}

/**
 * Sign and send an ERC-8004 IdentityRegistry.register(metadataURI) transaction.
 * Returns { txHash, address } or throws.
 */
export async function mintERC8004Identity(db, agentId, agentName, metadataURI) {
  const tk = getTurnkey();
  if (!tk) throw new Error('Turnkey not configured. Set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY in .env');

  // Get or create wallet
  const wallet = await getOrCreateAgentWallet(db, agentId, agentName);
  if (!wallet) throw new Error('Failed to create Turnkey wallet for agent');

  const apiClient = tk.apiClient();

  // Create a viem-compatible Turnkey account
  const turnkeyAccount = await createAccount({
    client: apiClient,
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
    signWith: wallet.address,
  });

  // Create viem clients
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account: turnkeyAccount,
    chain: arcTestnet,
    transport: http(),
  });

  // Encode the register(metadataURI) call
  const data = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [metadataURI],
  });

  // Send the transaction
  const txHash = await walletClient.sendTransaction({
    to: IDENTITY_REGISTRY,
    data,
    value: 0n,
  });

  console.log(`  ERC-8004 mint tx sent by agent ${agentName}: ${txHash}`);

  return {
    txHash,
    address: wallet.address,
    explorer: `https://explorer.testnet.arc.network/tx/${txHash}`,
  };
}

/**
 * List all Turnkey wallets in the org (for admin/debugging).
 */
export async function listTurnkeyWallets() {
  const tk = getTurnkey();
  if (!tk) return [];

  const apiClient = tk.apiClient();
  const response = await apiClient.getWallets();
  return response.wallets || [];
}
