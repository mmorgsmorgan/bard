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
  const walletAccount = user?.linkedAccounts?.find((account) => (
    account?.type === 'wallet' &&
    account?.chainType !== 'solana' &&
    account?.walletClientType !== 'privy'
  )) || linkedAccount(user, 'wallet');
  const loginWallet = (
    user?.wallet?.address ||
    walletAccount?.address
  )?.toLowerCase?.() || null;

  return {
    privyDid: claims.userId,
    email,
    emailVerifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null,
    loginWallet,
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

async function provisionManagedWallet(account) {
  if (account.wallet_address && account.wallet_id) return account;

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
    if (locked.wallet_address && locked.wallet_id) {
      await client.query('COMMIT');
      return locked;
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
          SET wallet_id = $1, wallet_address = LOWER($2), updated_at = $3
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

async function upsertHumanAccount(identity) {
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
  return provisionManagedWallet(await stmts.getHumanAccountByPrivyDid(identity.privyDid));
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email || null,
    emailVerified: Boolean(account.email && account.email_verified_at),
    loginWallet: account.login_wallet || null,
    wallet: {
      address: account.wallet_address,
      provider: getWalletProvider(pool).name,
      canExportPrivateKey: Boolean(
        account.email &&
        account.email_verified_at &&
        account.wallet_id?.startsWith('lw-')
      ),
    },
    createdAt: account.created_at,
  };
}

function mintHumanSession(account, jwtSecret) {
  return jwt.sign({
    sub: account.id,
    kind: 'human-session',
    privyDid: account.privy_did,
    wallet: account.wallet_address,
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

function mintElevatedToken(account, jwtSecret) {
  return jwt.sign({
    sub: account.id,
    kind: 'human-elevated',
    purpose: KEY_EXPORT_PURPOSE,
    wallet: account.wallet_address,
  }, jwtSecret, { expiresIn: ELEVATED_TTL });
}

function requireElevatedKeyExport(jwtSecret) {
  return (req, res, next) => {
    try {
      const claims = jwt.verify(req.headers['x-elevated-token'] || '', jwtSecret);
      if (
        claims.kind !== 'human-elevated' ||
        claims.purpose !== KEY_EXPORT_PURPOSE ||
        claims.sub !== req.human.id ||
        claims.wallet?.toLowerCase() !== req.human.wallet_address?.toLowerCase()
      ) {
        return res.status(403).json({ error: 'Fresh email verification required' });
      }
      next();
    } catch {
      return res.status(403).json({ error: 'Fresh email verification required' });
    }
  };
}

async function recordSecurityEvent(req, eventType) {
  await pool.query(
    `INSERT INTO human_security_events
       (id, human_id, wallet_address, event_type, ip_address, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      `security-${randomUUID()}`,
      req.human.id,
      req.human.wallet_address,
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
      const { privyToken } = req.body || {};
      const identity = await verifyPrivyToken(privyToken);
      const account = await upsertHumanAccount(identity);
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
      });
    }
  });

  router.get('/me', requireSession, (req, res) => {
    res.json({ account: publicAccount(req.human) });
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
      if (!req.human.wallet_id?.startsWith('lw-')) {
        return res.status(409).json({
          error: 'Private-key export is unavailable for this managed wallet',
        });
      }

      const code = await issueKeyExportOtp(req.human, jwtSecret);
      await sendHumanSecurityCode({ to: req.human.email, code });
      await recordSecurityEvent(req, 'key_export_code_requested');
      res.json({
        sent: true,
        channel: 'email',
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
      await recordSecurityEvent(req, 'key_export_code_verified');
      res.json({
        elevatedToken: mintElevatedToken(req.human, jwtSecret),
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
          req.human.wallet_address
        );
        await recordSecurityEvent(req, 'private_key_exported');
        console.warn(
          `[security] BARD private key exported for human ${req.human.id} (${req.human.wallet_address})`
        );
        res.json({ address: req.human.wallet_address, privateKey });
      } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
      }
    }
  );

  return router;
}
