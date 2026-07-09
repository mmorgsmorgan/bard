// ══════════════════════════════════════════════════════════════
// SIWE — Sign-In With Ethereum (EIP-4361) wallet sessions.
//
// Self-contained Express router. Reuses the app's existing JWT_SECRET so
// SIWE sessions share the same bearer-token scheme as agent tokens.
//
// Flow:
//   1. GET  /auth/nonce?address=0x..   → { nonce }  (one-time, short-lived)
//   2. POST /auth/verify { address, message, signature }
//        → verifies the EIP-191 signature over the SIWE message and that the
//          message embeds the issued nonce → { token, address }
//   3. Client sends `Authorization: Bearer <token>` on subsequent requests.
//   4. requireWalletSession middleware validates it → req.walletSession.
//
// No new dependency: viem.verifyMessage + jsonwebtoken (already imported by
// the server) do all the work. Nonces are kept in-memory with a TTL; for a
// single-instance deploy that's sufficient. Swap _nonces for a shared store
// (Redis/DB) if the backend is horizontally scaled.
// ══════════════════════════════════════════════════════════════

import express from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { verifyMessage } from 'viem';

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL = '7d';

// address(lowercase) → { nonce, expires }
const _nonces = new Map();

function issueNonce(address) {
  const nonce = randomBytes(16).toString('hex');
  _nonces.set(address, { nonce, expires: Date.now() + NONCE_TTL_MS });
  return nonce;
}

function consumeNonce(address, nonce) {
  const rec = _nonces.get(address);
  if (!rec) return false;
  _nonces.delete(address); // one-time use
  if (rec.expires < Date.now()) return false;
  return rec.nonce === nonce;
}

// Periodically sweep expired nonces so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [addr, rec] of _nonces) {
    if (rec.expires < now) _nonces.delete(addr);
  }
}, NONCE_TTL_MS).unref?.();

/**
 * Build the canonical SIWE (EIP-4361) message. The frontend must render the
 * exact same string for the signature to verify.
 */
export function buildSiweMessage({ domain, address, uri, chainId, nonce, issuedAt }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to BARD — proof of work you actually own.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/**
 * Create the SIWE router.
 * @param {object} opts
 * @param {string} opts.jwtSecret  Shared JWT secret (reuse server's JWT_SECRET).
 */
export function createSiweRouter({ jwtSecret }) {
  const router = express.Router();

  // 1) Issue a nonce for an address.
  router.get('/auth/nonce', (req, res) => {
    const address = String(req.query.address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return res.status(400).json({ error: 'valid ?address=0x... required' });
    }
    const nonce = issueNonce(address);
    res.json({ nonce });
  });

  // 2) Verify a signed SIWE message → issue a session token.
  router.post('/auth/verify', async (req, res) => {
    try {
      const { address, message, signature, nonce } = req.body || {};
      if (!address || !message || !signature) {
        return res.status(400).json({ error: 'address, message, signature required' });
      }
      const addr = String(address).toLowerCase();

      // The nonce must be present in the signed message AND match the one we issued.
      const embeddedNonce = /Nonce:\s*([0-9a-fA-F]+)/.exec(message)?.[1];
      const claimedNonce = nonce || embeddedNonce;
      if (!claimedNonce || !consumeNonce(addr, claimedNonce)) {
        return res.status(401).json({ error: 'invalid or expired nonce' });
      }
      if (embeddedNonce && embeddedNonce !== claimedNonce) {
        return res.status(401).json({ error: 'nonce mismatch' });
      }

      // Verify the signature was produced by `address` over exactly `message`.
      const valid = await verifyMessage({
        address: addr,
        message,
        signature,
      });
      if (!valid) {
        return res.status(401).json({ error: 'signature verification failed' });
      }

      const token = jwt.sign(
        { sub: addr, wallet: addr, kind: 'wallet-session' },
        jwtSecret,
        { expiresIn: SESSION_TTL },
      );
      res.json({ token, address: addr, expiresIn: SESSION_TTL });
    } catch (err) {
      res.status(500).json({ error: 'verify failed', detail: String(err?.message || err) });
    }
  });

  // 3) Return the caller's session (handy for the client to validate a stored token).
  router.get('/auth/me', requireWalletSession(jwtSecret), (req, res) => {
    res.json({ address: req.walletSession.wallet, kind: req.walletSession.kind });
  });

  return router;
}

/**
 * Middleware: require a valid wallet session. Attaches req.walletSession.
 * Optional — apply to routes you want to gate on a proven wallet session.
 */
export function requireWalletSession(jwtSecret) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Bearer token required' });
    try {
      const claims = jwt.verify(token, jwtSecret);
      if (claims.kind !== 'wallet-session') {
        return res.status(403).json({ error: 'not a wallet session token' });
      }
      req.walletSession = claims;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}
