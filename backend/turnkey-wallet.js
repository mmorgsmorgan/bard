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
import { withMemo, MemoIds } from './arc-memo.js';

// ── Arc Testnet Chain Definition ──
// Arc uses stablecoins (USDC) as gas, not ETH.
// Exported so server.js can reuse a single source instead of redefining it.
export const arcTestnet = {
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
  // Check if agent already has a managed wallet (columns are named turnkey_* for
  // history but hold whichever provider's wallet — Turnkey or self-hosted local).
  const { rows } = await db.query(
    'SELECT turnkey_wallet_id, turnkey_address FROM agents WHERE id = $1',
    [agentId]
  );
  const agent = rows[0];

  if (agent?.turnkey_wallet_id && agent?.turnkey_address) {
    return { walletId: agent.turnkey_wallet_id, address: agent.turnkey_address };
  }

  // Create new wallet via the configured provider. Default (turnkey) path is
  // unchanged; local/hybrid create a self-hosted encrypted wallet instead.
  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  let wallet;
  if (mode === 'local' || mode === 'hybrid') {
    const { getWalletProvider } = await import('./wallet-provider.js');
    try {
      wallet = await getWalletProvider(db).createWallet(`bard-agent-${agentId}`);
    } catch (err) {
      return { error: 'local_create_wallet_failed', detail: err.message };
    }
  } else {
    wallet = await createAgentWallet(agentId, agentName);
    if (!wallet) return null;                // Turnkey not configured
    if (wallet.error) return wallet;         // Turnkey API failed — pass through
  }

  // Store in DB (same columns regardless of provider)
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

  // Wrap with Arc Memo so the mint carries reconciliation context (agentId
  // + agentName + metadataURI) indexable by topic. The Memo contract uses
  // the CallFrom precompile to preserve the agent's wallet as msg.sender,
  // so the registry still records the correct owner.
  const wrapped = withMemo(
    { to: IDENTITY_REGISTRY, data },
    {
      memoId: MemoIds.IdentityMint,
      memoData: {
        agentId,
        agentName,
        agentWallet: wallet.address,
        metadataURI,
      },
    },
  );

  // Send the transaction
  const txHash = await walletClient.sendTransaction({
    to: wrapped.to,
    data: wrapped.data,
    value: 0n,
  });

  console.log(`  ERC-8004 mint tx sent by agent ${agentName} [memo:identity]: ${txHash}`);

  return {
    txHash,
    address: wallet.address,
    explorer: `https://explorer.testnet.arc.network/tx/${txHash}`,
  };
}

/**
 * Sign an arbitrary message with an agent's Turnkey wallet (EIP-191 personal_sign).
 *
 * This is what makes BARD's "verifiable proof of work" real: the agent's own
 * custodial key signs the canonical contribution/verification message, and the
 * backend (or anyone) can recover the signer with viem `verifyMessage` and
 * confirm it matches the agent's on-chain identity address.
 *
 * Returns { signature, address }. Throws if Turnkey is not configured.
 */
export async function signMessageWithAgentWallet(db, agentId, agentName, message) {
  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();

  // local/hybrid: sign through the configured provider (self-hosted keystore).
  if (mode === 'local' || mode === 'hybrid') {
    const wallet = await getOrCreateAgentWallet(db, agentId, agentName);
    if (!wallet || wallet.error) throw new Error(`Failed to resolve agent wallet: ${wallet?.detail || 'unknown'}`);
    const { getWalletProvider } = await import('./wallet-provider.js');
    const signature = await getWalletProvider(db).signMessage(wallet.address, message);
    return { signature, address: wallet.address };
  }

  const tk = getTurnkey();
  if (!tk) throw new Error('Turnkey not configured — cannot sign as agent');

  const wallet = await getOrCreateAgentWallet(db, agentId, agentName);
  if (!wallet) throw new Error('Failed to resolve Turnkey wallet for agent');

  const apiClient = tk.apiClient();
  const turnkeyAccount = await createAccount({
    client: apiClient,
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
    signWith: wallet.address,
  });

  const signature = await turnkeyAccount.signMessage({ message });
  return { signature, address: wallet.address };
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

/**
 * Audit Turnkey org against the agents table. Returns three buckets:
 *   - ok:        wallet correctly bound to an agent row
 *   - adoptable: wallet exists, agent row exists, but DB link is missing
 *   - stranded:  wallet exists in Turnkey, agent row deleted
 *
 * Read-only. The caller decides whether to apply reconciliation SQL
 * (typically via audit-turnkey-orphans.mjs with --apply).
 */
export async function auditTurnkeyOrphans(db) {
  const tk = getTurnkey();
  if (!tk) return { error: 'turnkey_not_configured' };

  const apiClient = tk.apiClient();
  const orgId = process.env.TURNKEY_ORGANIZATION_ID;
  const { wallets } = await apiClient.getWallets({ organizationId: orgId });

  const agentWallets = wallets.filter(w => (w.walletName || '').startsWith('bard-agent-'));
  const platformWallets = wallets.filter(w => (w.walletName || '').startsWith('bard-platform-'));

  const { rows: dbAgents } = await db.query(
    `SELECT id, agent_name, turnkey_wallet_id, turnkey_address, owner_wallet
       FROM agents WHERE turnkey_wallet_id IS NOT NULL OR turnkey_address IS NOT NULL`
  );
  const dbByWalletId = new Map(
    dbAgents.filter(a => a.turnkey_wallet_id).map(a => [a.turnkey_wallet_id, a])
  );

  const ok = [];
  const adoptable = [];
  const stranded = [];

  for (const w of agentWallets) {
    if (dbByWalletId.has(w.walletId)) {
      ok.push({ walletId: w.walletId, walletName: w.walletName });
      continue;
    }
    const expectedAgentId = w.walletName.replace(/^bard-agent-/, '');
    const { rows: matchRows } = await db.query(
      `SELECT id, agent_name FROM agents WHERE id = $1`, [expectedAgentId]
    );
    const matchAgent = matchRows[0];
    if (matchAgent) {
      let addr = null;
      try {
        const { accounts } = await apiClient.getWalletAccounts({ organizationId: orgId, walletId: w.walletId });
        addr = accounts?.[0]?.address || null;
      } catch { /* leave addr null */ }
      // Pull owner_wallet so the remediation SQL can include it when
      // the agent is still on the 0x000 placeholder.
      const { rows: ownerRows } = await db.query(
        `SELECT owner_wallet FROM agents WHERE id = $1`, [matchAgent.id]
      );
      const ownerWallet = ownerRows[0]?.owner_wallet || '';
      const ZERO = '0x0000000000000000000000000000000000000000';
      // Build the exact UPDATE statement an operator can paste into psql
      // (or audit-turnkey-orphans.mjs --apply). Quotes are single-quoted
      // PostgreSQL string literals; identifiers are not user-supplied.
      const sql = addr
        ? `UPDATE agents SET turnkey_wallet_id = '${w.walletId}', turnkey_address = '${addr}'${
            ownerWallet.toLowerCase() === ZERO ? `, owner_wallet = '${addr}'` : ''
          } WHERE id = '${matchAgent.id}';`
        : null;
      adoptable.push({
        walletId: w.walletId,
        walletName: w.walletName,
        agentId: matchAgent.id,
        agentName: matchAgent.agent_name,
        address: addr,
        remediationSql: sql,
      });
    } else {
      stranded.push({ walletId: w.walletId, walletName: w.walletName });
    }
  }

  return {
    summary: {
      totalAgentWallets: agentWallets.length,
      platformWallets: platformWallets.length,
      ok: ok.length,
      adoptable: adoptable.length,
      stranded: stranded.length,
    },
    adoptable,
    stranded,
  };
}

/**
 * Bulk-delete one or more Turnkey wallets by walletId. Used to clean up
 * stranded agent wallets after DB-side test-artifact purges leave orphaned
 * Turnkey state. Returns { deleted, failed } counts. Skip-list avoids
 * touching platform wallets or any wallet still bound to an agent in this
 * backend's agent table.
 *
 * Irreversible. Standalone function — auditTurnkeyOrphans should be run
 * first (read-only) to confirm which wallets are genuinely stranded.
 */
export async function deleteStrandedWallets(db, walletIds) {
  const tk = getTurnkey();
  if (!tk) return { error: 'turnkey_not_configured' };

  if (!walletIds?.length) return { deleted: 0, failed: 0 };

  // Safety: refuse if any of these IDs belong to a platform wallet or an
  // agent wallet that still has a matching DB row.
  const { rows: linkedAgents } = await db.query(
    `SELECT turnkey_wallet_id FROM agents WHERE turnkey_wallet_id = ANY($1)`,
    [walletIds]
  );
  const linkedIds = new Set(linkedAgents.map(a => a.turnkey_wallet_id));
  const { wallets: allWallets } = await tk.apiClient().getWallets({
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
  });
  const platformIds = new Set(
    allWallets.filter(w => (w.walletName || '').startsWith('bard-platform-')).map(w => w.walletId)
  );

  const safe = walletIds.filter(id => !linkedIds.has(id) && !platformIds.has(id));
  const skipped = walletIds.length - safe.length;
  if (safe.length === 0) {
    return { deleted: 0, failed: 0, skipped };
  }

  const apiClient = tk.apiClient();
  let deleted = 0, failed = 0;
  // Turnkey deletes up to 20 wallets per call. deleteWithoutExport=true
  // is required — Turnkey refuses to delete a wallet that hasn't been
  // exported (i.e. operator hasn't acknowledged "I have the seed phrase,
  // I accept losing access"). For stranded BARD agent wallets the seed
  // never existed on our side, so the flag is safe.
  for (let i = 0; i < safe.length; i += 20) {
    try {
      await apiClient.deleteWallets({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID,
        walletIds: safe.slice(i, i + 20),
        deleteWithoutExport: true,
      });
      deleted += Math.min(20, safe.length - i);
    } catch (err) {
      console.error(`  Batch delete failed (${i}-${i + 20}):`, err.message);
      failed += Math.min(20, safe.length - i);
    }
  }

  return { deleted, failed, skipped };
}
