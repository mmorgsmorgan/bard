// wallet-provider.js — pluggable managed-wallet backend for BARD.
//
// BARD needs one thing from a "wallet provider": given an agent, hand back a viem
// `account` the backend can sign/send with — so the platform transacts on the agent's
// behalf with no seed-phrase UX. Turnkey does this via MPC/TEE (createAccount →
// walletClient). This module abstracts that so Turnkey is ONE implementation and a
// self-hosted encrypted keystore ("local") is another, chosen by WALLET_PROVIDER.
//
//   getWalletProvider(pool) -> { name, enabled(), createWallet(label),
//                                getAccount(address), getSigner(address),
//                                signMessage(address, message),
//                                exportPrivateKey(address) }
//
// Because both providers return a standard viem account, escrow-service.js's signerFor
// and turnkey-wallet.js's walletClient construction work unchanged against either.
//
// TRADE-OFF (local): keys are custodial — encrypted at rest with AES-256-GCM under a
// per-record scrypt key derived from WALLET_MASTER_KEY. Compromise of that master key
// compromises every agent wallet. For production, source WALLET_MASTER_KEY from a
// KMS/HSM (envelope-encrypt the master), never a plaintext env. For Arc testnet it's
// an acceptable, Turnkey-free, quota-free path with identical seamless signing.

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';

const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
export const ARC_CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
};

// ──────────────────────────────────────────────
//  AES-256-GCM envelope encryption (per-record salt + scrypt DEK)
// ──────────────────────────────────────────────
function masterKey() {
  const k = process.env.WALLET_MASTER_KEY;
  if (!k) return null;
  // Accept 64-hex (32 bytes) or any passphrase (hashed via scrypt at derive time).
  return /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, 'hex') : Buffer.from(k, 'utf8');
}

function encryptSecret(plaintextHex) {
  const master = masterKey();
  if (!master) throw new Error('WALLET_MASTER_KEY not set');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const dek = scryptSync(master, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([cipher.update(plaintextHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('hex'),
  };
}

function decryptSecret({ salt, iv, tag, ct }) {
  const master = masterKey();
  if (!master) throw new Error('WALLET_MASTER_KEY not set');
  const dek = scryptSync(master, Buffer.from(salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

// ──────────────────────────────────────────────
//  Local (self-hosted encrypted keystore) provider
// ──────────────────────────────────────────────
class LocalWalletProvider {
  constructor(pool) {
    this.name = 'local';
    this.pool = pool;
    this._cache = new Map(); // address(lower) -> viem account
    this._ready = null;
  }

  enabled() {
    return !!masterKey();
  }

  async init() {
    if (this._ready) return this._ready;
    this._ready = this.pool.query(`
      CREATE TABLE IF NOT EXISTS local_wallets (
        address    TEXT PRIMARY KEY,
        key_id     TEXT UNIQUE NOT NULL,
        label      TEXT,
        enc_salt   TEXT NOT NULL,
        enc_iv     TEXT NOT NULL,
        enc_tag    TEXT NOT NULL,
        enc_ct     TEXT NOT NULL,
        created_at TEXT DEFAULT (NOW()::text)
      )
    `);
    return this._ready;
  }

  /** Generate a fresh EOA, store its encrypted key, return { walletId, address }. */
  async createWallet(label = 'bard-wallet') {
    if (!this.enabled()) throw new Error('LocalWalletProvider disabled: WALLET_MASTER_KEY not set');
    await this.init();
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const address = account.address;
    const keyId = `lw-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const enc = encryptSecret(pk);
    await this.pool.query(
      `INSERT INTO local_wallets (address, key_id, label, enc_salt, enc_iv, enc_tag, enc_ct, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [address.toLowerCase(), keyId, label, enc.salt, enc.iv, enc.tag, enc.ct, new Date().toISOString()]
    );
    this._cache.set(address.toLowerCase(), account);
    return { walletId: keyId, address };
  }

  /** Decrypt the stored key and return a viem LocalAccount (cached). */
  async _loadPk(address) {
    await this.init();
    const { rows } = await this.pool.query(
      'SELECT enc_salt, enc_iv, enc_tag, enc_ct FROM local_wallets WHERE address = $1',
      [address.toLowerCase()]
    );
    if (!rows[0]) throw Object.assign(
      new Error(`local-wallet: no key for ${address}`),
      { status: 404 }
    );
    return decryptSecret({
      salt: rows[0].enc_salt,
      iv: rows[0].enc_iv,
      tag: rows[0].enc_tag,
      ct: rows[0].enc_ct,
    });
  }

  /** Decrypt the stored key and return a viem LocalAccount (cached). */
  async getAccount(address) {
    const key = address.toLowerCase();
    if (this._cache.has(key)) return this._cache.get(key);
    const account = privateKeyToAccount(await this._loadPk(address));
    this._cache.set(key, account);
    return account;
  }

  /** viem walletClient bound to the agent's account — same shape Turnkey returns. */
  async getSigner(address) {
    const account = await this.getAccount(address);
    return createWalletClient({ account, chain: ARC_CHAIN, transport: http(ARC_RPC) });
  }

  async signMessage(address, message) {
    const account = await this.getAccount(address);
    return account.signMessage({ message });
  }

  /**
   * Return the raw private key for an explicitly elevated export flow.
   * Callers must perform fresh email OTP verification and audit the export.
   */
  async exportPrivateKey(address) {
    return this._loadPk(address);
  }
}

// ──────────────────────────────────────────────
//  Turnkey provider (thin adapter over the existing module)
// ──────────────────────────────────────────────
class TurnkeyWalletProvider {
  constructor() {
    this.name = 'turnkey';
    this._walletClients = new Map();
  }

  enabled() {
    return !!(process.env.TURNKEY_API_PRIVATE_KEY && process.env.TURNKEY_ORGANIZATION_ID);
  }

  async createWallet(label = 'bard-wallet') {
    const { createAgentWallet } = await import('./turnkey-wallet.js');
    const r = await createAgentWallet(label, label);
    if (!r || r.error) throw new Error(`turnkey createWallet failed: ${r?.detail || 'unknown'}`);
    return { walletId: r.walletId, address: r.address };
  }

  async getAccount(address) {
    const { createAccount } = await import('@turnkey/viem');
    const { Turnkey } = await import('@turnkey/sdk-server');
    const tk = new Turnkey({
      defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
      apiBaseUrl: 'https://api.turnkey.com',
      apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
      apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    });
    return createAccount({ client: tk.apiClient(), organizationId: process.env.TURNKEY_ORGANIZATION_ID, signWith: address });
  }

  async getSigner(address) {
    const key = address.toLowerCase();
    if (this._walletClients.has(key)) return this._walletClients.get(key);
    const account = await this.getAccount(address);
    const wc = createWalletClient({ account, chain: ARC_CHAIN, transport: http(ARC_RPC) });
    this._walletClients.set(key, wc);
    return wc;
  }

  async signMessage(address, message) {
    const account = await this.getAccount(address);
    return account.signMessage({ message });
  }

  async exportPrivateKey() {
    throw Object.assign(
      new Error('Private-key export is unavailable for Turnkey-managed wallets'),
      { status: 409, code: 'wallet_export_unsupported' }
    );
  }
}

// ──────────────────────────────────────────────
//  Hybrid provider — local-first, Turnkey fallback.
//  Migration path: NEW wallets are created locally; EXISTING Turnkey wallets keep
//  signing (when the org isn't quota-blocked). One interface, no flag day.
// ──────────────────────────────────────────────
class HybridWalletProvider {
  constructor(pool) {
    this.name = 'hybrid';
    this.local = new LocalWalletProvider(pool);
    this.turnkey = new TurnkeyWalletProvider();
  }
  enabled() { return this.local.enabled() || this.turnkey.enabled(); }
  // New wallets go local (Turnkey-free by default).
  createWallet(label) { return this.local.createWallet(label); }
  async _providerFor(address) {
    try {
      const { rows } = await this.local.pool.query('SELECT 1 FROM local_wallets WHERE address = $1', [address.toLowerCase()]);
      if (rows[0]) return this.local;
    } catch { /* local table may not exist yet — fall through to Turnkey */ }
    return this.turnkey;
  }
  async getAccount(address) { return (await this._providerFor(address)).getAccount(address); }
  async getSigner(address) { return (await this._providerFor(address)).getSigner(address); }
  async signMessage(address, message) { return (await this._providerFor(address)).signMessage(address, message); }
  async exportPrivateKey(address) {
    const provider = await this._providerFor(address);
    if (provider !== this.local) {
      throw Object.assign(
        new Error('Private-key export is unavailable for this legacy managed wallet'),
        { status: 409, code: 'wallet_export_unsupported' }
      );
    }
    return provider.exportPrivateKey(address);
  }
}

// ──────────────────────────────────────────────
//  Selector
// ──────────────────────────────────────────────
let _provider = null;

/**
 * Return the configured wallet provider (singleton).
 *   WALLET_PROVIDER = turnkey (default) | local | hybrid
 * 'hybrid' is the recommended migration mode (new=local, old=Turnkey). `pool` is
 * required for 'local'/'hybrid'.
 */
export function getWalletProvider(pool) {
  if (_provider) return _provider;
  const choice = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  if (choice === 'local') _provider = new LocalWalletProvider(pool);
  else if (choice === 'hybrid') _provider = new HybridWalletProvider(pool);
  else _provider = new TurnkeyWalletProvider();
  return _provider;
}

export { LocalWalletProvider, TurnkeyWalletProvider, HybridWalletProvider, encryptSecret, decryptSecret };
