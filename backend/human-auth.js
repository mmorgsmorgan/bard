import express from 'express';
import jwt from 'jsonwebtoken';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { PrivyClient } from '@privy-io/server-auth';
import { pool, stmts } from './db.js';
import { getWalletProvider } from './wallet-provider.js';
import { sendHumanSecurityCode } from './human-email-service.js';

const SESSION_TTL = '7d';
const ELEVATED_TTL = '5m';
const KEY_EXPORT_PURPOSE = 'key_export';
const OTP_MAX_ATTEMPTS = 5;
const LOGIN_VERIFICATION_WINDOW_MS = 5 * 60 * 1000;
let privyClient = null;

function getPrivyClient() {
  if (privyClient) return privyClient;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw Object.assign(new Error('Privy authentication is not configured'), { status: 503 });
  }
  privyClient = new PrivyClient(appId, appSecret);
  return privyClient;
}

function linkedAccount(user, type) {
  return user?.linkedAccounts?.find((account) => account?.type === type) || null;
}

function isExternalEvmWallet(account) {
  return Boolean(
    account?.type === 'wallet' &&
    account?.chainType !== 'solana' &&
    account?.walletClientType !== 'privy' &&
    /^0x[0-9a-fA-F]{40}$/.test(account?.address || '')
  );
}

function wasVerifiedForToken(account, claims) {
  const issuedAt = Number(claims?.issuedAt) * 1000;
  const verifiedAt = new Date(
    account?.latestVerifiedAt ||
    account?.verifiedAt ||
    account?.firstVerifiedAt ||
    0
  ).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(verifiedAt) || verifiedAt <= 0) {
    return false;
  }
  return (
    verifiedAt <= issuedAt + 30_000 &&
    issuedAt - verifiedAt <= LOGIN_VERIFICATION_WINDOW_MS
  );
}

function identityFromPrivyUser(user, claims) {
  const emailAccount = linkedAccount(user, 'email');
  const email = (emailAccount?.address || user?.email?.address)?.toLowerCase?.() || null;
  const verifiedAt = email
    ? (
      emailAccount?.firstVerifiedAt ||
      emailAccount?.verifiedAt ||
      emailAccount?.latestVerifiedAt ||
      user?.createdAt ||
      new Date()
    )
    : null;
  const walletCandidates = [user?.wallet, ...(user?.linkedAccounts || [])]
    .filter(isExternalEvmWallet);
  const externalWallets = [...new Set(
    walletCandidates.map((account) => account.address.toLowerCase())
  )];
  const authenticatedExternalWallets = [...new Set(
    walletCandidates
      .filter((account) => wasVerifiedForToken(account, claims))
      .map((account) => account.address.toLowerCase())
  )];

  return {
    privyDid: claims.userId,
    email,
    emailVerifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null,
    loginWallet: externalWallets[0] || null,
    externalWallets,
    authenticatedEmail: Boolean(
      email &&
      wasVerifiedForToken(emailAccount || user?.email, claims)
    ),
    authenticatedExternalWallets,
  };
}

async function verifyPrivyToken(privyToken) {
  if (!privyToken) {
    throw Object.assign(new Error('privyToken required'), { status: 400 });
  }
  const privy = getPrivyClient();
  const claims = await privy.verifyAuthToken(privyToken);
  const user = await privy.getUser(claims.userId);
  return identityFromPrivyUser(user, claims);
}

function requireLoginContext(authContext = {}) {
  const loginMethod = String(authContext.loginMethod || '').toLowerCase();
  if (!['email', 'siwe'].includes(loginMethod)) {
    throw Object.assign(
      new Error('Sign in again and choose email or an external wallet'),
      { status: 400, code: 'login_method_required' }
    );
  }
  return {
    loginMethod,
    loginWallet: String(authContext.loginWallet || '').toLowerCase(),
  };
}

function requestedWallet(identity, account, authContext = {}) {
  const loginMethod = String(authContext.loginMethod || '').toLowerCase();
  const requestedAddress = String(authContext.loginWallet || '').toLowerCase();
  if (loginMethod === 'email' && !identity.authenticatedEmail) {
    throw Object.assign(
      new Error('The current Privy session was not authenticated with email'),
      { status: 403, code: 'email_login_mismatch' }
    );
  }
  if (
    loginMethod === 'siwe' &&
    !identity.authenticatedExternalWallets?.includes(requestedAddress)
  ) {
    throw Object.assign(
      new Error('The current Privy session was not authenticated with this external wallet'),
      { status: 403, code: 'wallet_login_mismatch' }
    );
  }
  if (account?.wallet_type === 'managed') {
    if (loginMethod === 'siwe') {
      throw Object.assign(
        new Error('This BARD account was created with email. Sign in with email to use its managed wallet.'),
        { status: 409, code: 'account_login_method_mismatch' }
      );
    }
    return { type: 'managed', address: account.wallet_address || null };
  }
  if (account?.wallet_type === 'external') {
    if (loginMethod === 'email') {
      throw Object.assign(
        new Error('This BARD account is bound to an external wallet. Sign in with that wallet.'),
        { status: 409, code: 'account_login_method_mismatch' }
      );
    }
    if (
      loginMethod === 'siwe' &&
      requestedAddress !== account.wallet_address?.toLowerCase()
    ) {
      throw Object.assign(
        new Error('This BARD account is bound to a different external wallet'),
        { status: 409, code: 'account_login_method_mismatch' }
      );
    }
    if (!identity.externalWallets.includes(account.wallet_address?.toLowerCase())) {
      throw Object.assign(
        new Error('The external wallet for this BARD account is no longer linked in Privy'),
        { status: 409, code: 'external_wallet_not_linked' }
      );
    }
    return { type: 'external', address: account.wallet_address.toLowerCase() };
  }

  if (loginMethod === 'siwe') {
    return { type: 'external', address: requestedAddress };
  }
  if (loginMethod === 'email') {
    return { type: 'managed', address: null };
  }

  // Existing pre-migration rows default to their current managed wallet unless
  // a fresh Privy login callback explicitly proves that SIWE was used.
  if (account?.wallet_id && account?.wallet_address) {
    return {
      type: 'managed',
      address: account.wallet_address,
      classify: false,
    };
  }
  if (identity.authenticatedEmail && identity.authenticatedExternalWallets.length === 0) {
    return { type: 'managed', address: null };
  }
  if (!identity.authenticatedEmail && identity.authenticatedExternalWallets.length === 1) {
    return { type: 'external', address: identity.authenticatedExternalWallets[0] };
  }
  if (identity.email && identity.externalWallets.length === 0) {
    return { type: 'managed', address: null };
  }
  if (!identity.email && identity.externalWallets.length === 1) {
    return { type: 'external', address: identity.externalWallets[0] };
  }
  throw Object.assign(
    new Error('Sign in again and choose email or an external wallet'),
    { status: 400, code: 'login_method_required' }
  );
}

async function provisionManagedWallet(account, { classify = true } = {}) {
  if (account.wallet_type === 'external') {
    throw Object.assign(
      new Error('External-wallet accounts do not receive a BARD-managed wallet'),
      { status: 409, code: 'external_wallet_account' }
    );
  }
  if (account.wallet_address && account.wallet_id) {
    if (classify && account.wallet_type !== 'managed') {
      await pool.query(
        `UPDATE human_accounts
            SET wallet_type = 'managed', updated_at = $1
          WHERE id = $2`,
        [new Date().toISOString(), account.id]
      );
      return stmts.getHumanAccountById(account.id);
    }
    return account;
  }

  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  if (!['local', 'hybrid'].includes(mode) || !process.env.WALLET_MASTER_KEY) {
    throw Object.assign(
      new Error('BARD human wallets require WALLET_PROVIDER=local or hybrid with WALLET_MASTER_KEY'),
      { status: 503 }
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [account.privy_did]);
    const locked = (await client.query(
      'SELECT * FROM human_accounts WHERE privy_did = $1 FOR UPDATE',
      [account.privy_did]
    )).rows[0];
    if (locked.wallet_type === 'external') {
      throw Object.assign(
        new Error('External-wallet accounts do not receive a BARD-managed wallet'),
        { status: 409, code: 'external_wallet_account' }
      );
    }
    if (locked.wallet_address && locked.wallet_id) {
      if (classify && locked.wallet_type !== 'managed') {
        await client.query(
          `UPDATE human_accounts
              SET wallet_type = 'managed', updated_at = $1
            WHERE id = $2`,
          [new Date().toISOString(), locked.id]
        );
      }
      await client.query('COMMIT');
      return stmts.getHumanAccountById(locked.id);
    }

    const provider = getWalletProvider(pool);
    if (!['local', 'hybrid'].includes(provider.name) || !provider.enabled()) {
      throw Object.assign(
        new Error('BARD managed wallet provider is not configured'),
        { status: 503 }
      );
    }
    const wallet = await provider.createWallet(`bard-human-${locked.id}`);
    const updatedAt = new Date().toISOString();
    await client.query(
      `UPDATE human_accounts
          SET wallet_type = 'managed',
              wallet_id = $1,
              wallet_address = LOWER($2),
              updated_at = $3
        WHERE id = $4`,
      [wallet.walletId, wallet.address, updatedAt, locked.id]
    );
    const updated = (await client.query(
      'SELECT * FROM human_accounts WHERE id = $1',
      [locked.id]
    )).rows[0];
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function activateExternalWallet(account, address) {
  const normalized = address.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [account.privy_did]);
    const locked = (await client.query(
      'SELECT * FROM human_accounts WHERE privy_did = $1 FOR UPDATE',
      [account.privy_did]
    )).rows[0];

    if (locked.wallet_type === 'managed') {
      await client.query('COMMIT');
      return locked;
    }
    if (
      locked.wallet_type === 'external' &&
      locked.wallet_address?.toLowerCase() !== normalized
    ) {
      throw Object.assign(
        new Error('This BARD account is already bound to a different external wallet'),
        { status: 409, code: 'external_wallet_locked' }
      );
    }

    const collision = (await client.query(
      `SELECT id FROM human_accounts
        WHERE LOWER(wallet_address) = LOWER($1) AND id <> $2
        LIMIT 1`,
      [normalized, locked.id]
    )).rows[0];
    if (collision) {
      throw Object.assign(
        new Error('This external wallet already belongs to another BARD account'),
        { status: 409, code: 'wallet_already_registered' }
      );
    }

    const previousAddress = locked.wallet_address?.toLowerCase() || null;
    const previousWalletId = locked.wallet_id || null;
    await client.query(
      `UPDATE human_accounts
          SET wallet_type = 'external',
              login_wallet = $1,
              legacy_wallet_id = CASE
                WHEN wallet_id IS NOT NULL THEN wallet_id
                ELSE legacy_wallet_id
              END,
              legacy_wallet_address = CASE
                WHEN wallet_id IS NOT NULL THEN wallet_address
                ELSE legacy_wallet_address
              END,
              wallet_id = NULL,
              wallet_address = $1,
              updated_at = $2
        WHERE id = $3`,
      [normalized, new Date().toISOString(), locked.id]
    );

    // Legacy wallet-login accounts were incorrectly keyed by their generated
    // BARD wallet. Move off-chain ownership to the verified external wallet.
    if (previousWalletId && previousAddress && previousAddress !== normalized) {
      const destinationProfile = (await client.query(
        'SELECT wallet FROM profiles WHERE LOWER(wallet) = LOWER($1) LIMIT 1',
        [normalized]
      )).rows[0];
      if (!destinationProfile) {
        await client.query(
          'UPDATE profiles SET wallet = $1 WHERE LOWER(wallet) = LOWER($2)',
          [normalized, previousAddress]
        );
      }
      await client.query(
        'UPDATE portfolio SET wallet = $1 WHERE LOWER(wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE proofs SET contributor = $1 WHERE LOWER(contributor) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE notifications SET wallet = $1 WHERE LOWER(wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE agents SET owner_wallet = $1 WHERE LOWER(owner_wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE bounties SET creator_wallet = $1 WHERE LOWER(creator_wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        `UPDATE bounty_funding_transactions
            SET funder_wallet = $1
          WHERE LOWER(funder_wallet) = LOWER($2)`,
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE bounty_messages SET from_wallet = $1 WHERE LOWER(from_wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
      await client.query(
        'UPDATE bounty_messages SET to_wallet = $1 WHERE LOWER(to_wallet) = LOWER($2)',
        [normalized, previousAddress]
      );
    }

    const updated = (await client.query(
      'SELECT * FROM human_accounts WHERE id = $1',
      [locked.id]
    )).rows[0];
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upsertHumanAccount(identity, authContext) {
  const existing = await stmts.getHumanAccountByPrivyDid(identity.privyDid);
  const id = existing?.id || `human-${randomUUID()}`;
  await stmts.insertHumanAccount({
    id,
    privy_did: identity.privyDid,
    email: identity.email,
    email_verified_at: identity.emailVerifiedAt,
    login_wallet: identity.loginWallet,
    created_at: new Date().toISOString(),
  });
  const account = await stmts.getHumanAccountByPrivyDid(identity.privyDid);
  const wallet = requestedWallet(identity, account, authContext);
  return wallet.type === 'external'
    ? activateExternalWallet(account, wallet.address)
    : provisionManagedWallet(account, { classify: wallet.classify !== false });
}

async function syncHumanIdentity(account, identity) {
  await pool.query(
    `UPDATE human_accounts
        SET email = $1,
            email_verified_at = $2,
            updated_at = $3
      WHERE id = $4`,
    [
      identity.email,
      identity.emailVerifiedAt,
      new Date().toISOString(),
      account.id,
    ]
  );
  return stmts.getHumanAccountById(account.id);
}

function publicAccount(account) {
  const walletType = account.wallet_type === 'external' ? 'external' : 'managed';
  const provider = walletType === 'external' ? 'external' : getWalletProvider(pool).name;
  return {
    id: account.id,
    email: account.email || null,
    emailVerified: Boolean(account.email && account.email_verified_at),
    loginWallet: account.login_wallet || null,
    wallet: {
      address: account.wallet_address,
      type: walletType,
      provider,
      canExportPrivateKey: Boolean(
        walletType === 'managed' &&
        account.email &&
        account.email_verified_at &&
        account.wallet_id?.startsWith('lw-')
      ),
    },
    legacyManagedWallet: account.legacy_wallet_address ? {
      address: account.legacy_wallet_address,
      provider: account.legacy_wallet_id?.startsWith('lw-') ? 'local' : 'turnkey',
      canExportPrivateKey: Boolean(
        account.email &&
        account.email_verified_at &&
        account.legacy_wallet_id?.startsWith('lw-')
      ),
    } : null,
    createdAt: account.created_at,
  };
}

function mintHumanSession(account, jwtSecret) {
  return jwt.sign({
    sub: account.id,
    kind: 'human-session',
    privyDid: account.privy_did,
    wallet: account.wallet_address,
    walletType: account.wallet_type === 'external' ? 'external' : 'managed',
  }, jwtSecret, { expiresIn: SESSION_TTL });
}

function hashOtp(code, jwtSecret) {
  const pepper = process.env.HUMAN_OTP_PEPPER || process.env.OTP_PEPPER || jwtSecret;
  return createHash('sha256').update(`${code}:${pepper}`).digest('hex');
}

function generateOtpCode() {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

async function issueKeyExportOtp(account, jwtSecret) {
  const recent = await pool.query(
    `SELECT 1
       FROM human_otp_codes
      WHERE human_id = $1 AND purpose = $2
        AND created_at > NOW() - INTERVAL '60 seconds'
      LIMIT 1`,
    [account.id, KEY_EXPORT_PURPOSE]
  );
  if (recent.rows[0]) {
    throw Object.assign(
      new Error('Wait 60 seconds before requesting another security code'),
      { status: 429 }
    );
  }

  const code = generateOtpCode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE human_otp_codes
          SET consumed = 1
        WHERE human_id = $1 AND purpose = $2 AND consumed = 0`,
      [account.id, KEY_EXPORT_PURPOSE]
    );
    await client.query(
      `INSERT INTO human_otp_codes
         (human_id, code_hash, purpose, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [account.id, hashOtp(code, jwtSecret), KEY_EXPORT_PURPOSE]
    );
    await client.query('COMMIT');
    return code;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function verifyKeyExportOtp(account, code, jwtSecret) {
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    return { ok: false, error: 'Enter the 6-digit security code' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT *
         FROM human_otp_codes
        WHERE human_id = $1 AND purpose = $2 AND consumed = 0
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [account.id, KEY_EXPORT_PURPOSE]
    )).rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'No active code. Request a new one.' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('UPDATE human_otp_codes SET consumed = 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return { ok: false, error: 'Code expired. Request a new one.' };
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query('UPDATE human_otp_codes SET consumed = 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return { ok: false, error: 'Too many attempts. Request a new code.' };
    }

    const supplied = Buffer.from(hashOtp(String(code).trim(), jwtSecret), 'hex');
    const expected = Buffer.from(row.code_hash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      const nextAttempts = row.attempts + 1;
      await client.query(
        'UPDATE human_otp_codes SET attempts = $1, consumed = $2 WHERE id = $3',
        [nextAttempts, nextAttempts >= OTP_MAX_ATTEMPTS ? 1 : 0, row.id]
      );
      await client.query('COMMIT');
      return {
        ok: false,
        error: nextAttempts >= OTP_MAX_ATTEMPTS
          ? 'Too many attempts. Request a new code.'
          : 'Incorrect security code',
      };
    }

    await client.query('UPDATE human_otp_codes SET consumed = 1 WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function exportableWallet(account, target = 'primary') {
  if (target === 'legacy') {
    if (!account.legacy_wallet_id || !account.legacy_wallet_address) return null;
    return {
      id: account.legacy_wallet_id,
      address: account.legacy_wallet_address,
    };
  }
  if (account.wallet_type === 'external' || !account.wallet_id || !account.wallet_address) {
    return null;
  }
  return { id: account.wallet_id, address: account.wallet_address };
}

function mintElevatedKeyExportToken(account, wallet, jwtSecret) {
  return jwt.sign({
    sub: account.id,
    kind: 'human-elevated',
    purpose: KEY_EXPORT_PURPOSE,
    wallet: wallet.address,
  }, jwtSecret, { expiresIn: ELEVATED_TTL });
}

function requireElevatedKeyExport(jwtSecret) {
  return (req, res, next) => {
    try {
      const claims = jwt.verify(req.headers['x-elevated-token'] || '', jwtSecret);
      const allowedWallets = [
        exportableWallet(req.human, 'primary'),
        exportableWallet(req.human, 'legacy'),
      ].filter(Boolean);
      const exportWallet = allowedWallets.find(
        (wallet) => wallet.address.toLowerCase() === claims.wallet?.toLowerCase()
      );
      if (
        claims.kind !== 'human-elevated' ||
        claims.purpose !== KEY_EXPORT_PURPOSE ||
        claims.sub !== req.human.id ||
        !exportWallet
      ) {
        return res.status(403).json({ error: 'Fresh email verification required' });
      }
      req.exportWallet = exportWallet;
      next();
    } catch {
      return res.status(403).json({ error: 'Fresh email verification required' });
    }
  };
}

async function recordSecurityEvent(req, eventType, walletAddress = req.human.wallet_address) {
  await pool.query(
    `INSERT INTO human_security_events
       (id, human_id, wallet_address, event_type, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      `security-${randomUUID()}`,
      req.human.id,
      walletAddress,
      eventType,
      String(req.ip || req.socket?.remoteAddress || '').slice(0, 100),
      String(req.headers['user-agent'] || '').slice(0, 500),
    ]
  );
}

async function provisionStackProjects(privyToken) {
  const urls = (process.env.BARD_STACK_PROVISION_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) return [];

  return Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privyToken }),
        signal: AbortSignal.timeout(10_000),
      });
      return { url, ok: response.ok, status: response.status };
    } catch (error) {
      return { url, ok: false, error: error.message };
    }
  }));
}

export function requireHumanSession(jwtSecret) {
  return async (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Bearer token required' });
    try {
      const claims = jwt.verify(token, jwtSecret);
      if (claims.kind !== 'human-session') {
        return res.status(403).json({ error: 'Human session required' });
      }
      const account = await stmts.getHumanAccountById(claims.sub);
      if (!account || account.wallet_address?.toLowerCase() !== claims.wallet?.toLowerCase()) {
        return res.status(401).json({ error: 'Account session is no longer valid' });
      }
      req.human = account;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  };
}

export function createHumanAuthRouter({ jwtSecret }) {
  const router = express.Router();
  const requireSession = requireHumanSession(jwtSecret);

  router.post('/auth', async (req, res) => {
    try {
      const { privyToken, loginMethod, loginWallet } = req.body || {};
      const authContext = requireLoginContext({ loginMethod, loginWallet });
      const identity = await verifyPrivyToken(privyToken);
      const account = await upsertHumanAccount(identity, authContext);
      const projects = await provisionStackProjects(privyToken);
      res.json({
        token: mintHumanSession(account, jwtSecret),
        expiresIn: SESSION_TTL,
        account: publicAccount(account),
        projects,
      });
    } catch (error) {
      console.error('[human-auth] login failed:', error.message);
      res.status(error.status || 401).json({
        error: error.status ? error.message : 'Privy login verification failed',
        code: error.code,
      });
    }
  });

  router.get('/me', requireSession, async (req, res) => {
    try {
      const identity = await verifyPrivyToken(req.headers['x-privy-token']);
      if (identity.privyDid !== req.human.privy_did) {
        return res.status(401).json({ error: 'BARD session does not match the current Privy user' });
      }
      if (
        req.human.wallet_type === 'external' &&
        !identity.externalWallets.includes(req.human.wallet_address?.toLowerCase())
      ) {
        return res.status(409).json({
          error: 'The external wallet for this BARD account is no longer linked in Privy',
          code: 'external_wallet_not_linked',
        });
      }
      const account = await syncHumanIdentity(req.human, identity);
      res.json({ account: publicAccount(account) });
    } catch {
      res.status(401).json({ error: 'Current Privy authentication required' });
    }
  });

  router.post('/logout', requireSession, (_req, res) => {
    res.json({ success: true });
  });

  router.post('/wallet/export-key/request', requireSession, async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    try {
      if (!req.human.email || !req.human.email_verified_at) {
        return res.status(400).json({
          error: 'Link and verify an email address before exporting your private key',
        });
      }
      const target = req.body?.target === 'legacy' ? 'legacy' : 'primary';
      const wallet = exportableWallet(req.human, target);
      if (!wallet?.id?.startsWith('lw-')) {
        return res.status(409).json({
          error: target === 'legacy'
            ? 'No exportable legacy BARD wallet is attached to this account'
            : 'Private-key export is unavailable for this wallet',
        });
      }

      const code = await issueKeyExportOtp(req.human, jwtSecret);
      await sendHumanSecurityCode({ to: req.human.email, code });
      await recordSecurityEvent(req, 'key_export_code_requested', wallet.address);
      res.json({
        sent: true,
        channel: 'email',
        target,
        ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  router.post('/wallet/export-key/verify', requireSession, async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    try {
      const result = await verifyKeyExportOtp(req.human, req.body?.code, jwtSecret);
      if (!result.ok) return res.status(403).json({ error: result.error });
      const target = req.body?.target === 'legacy' ? 'legacy' : 'primary';
      const wallet = exportableWallet(req.human, target);
      if (!wallet?.id?.startsWith('lw-')) {
        return res.status(409).json({ error: 'Private-key export is unavailable for this wallet' });
      }
      await recordSecurityEvent(req, 'key_export_code_verified', wallet.address);
      res.json({
        elevatedToken: mintElevatedKeyExportToken(req.human, wallet, jwtSecret),
        expiresInSeconds: 300,
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  });

  router.post(
    '/wallet/export-key',
    requireSession,
    requireElevatedKeyExport(jwtSecret),
    async (req, res) => {
      res.set('Cache-Control', 'no-store, private');
      try {
        const privateKey = await getWalletProvider(pool).exportPrivateKey(
          req.exportWallet.address
        );
        await recordSecurityEvent(req, 'private_key_exported', req.exportWallet.address);
        console.warn(
          `[security] BARD private key exported for human ${req.human.id} (${req.exportWallet.address})`
        );
        res.json({ address: req.exportWallet.address, privateKey });
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    }
  );

  return router;
}

export const humanAuthTestUtils = Object.freeze({
  identityFromPrivyUser,
  requireLoginContext,
  requestedWallet,
  upsertHumanAccount,
});
