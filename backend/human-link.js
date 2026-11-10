import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyMessage } from 'viem';
import { getOwnerAssurance } from './ethos-service.js';
import { getPassportAssurance, passportConfigured } from './passport-service.js';

const LIFETIME_MS = 15 * 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
const assetRoot = fileURLToPath(new URL('../shared/mcp/human-link/', import.meta.url));

export function humanLinkOrigin(env = process.env) {
  try {
    const url = new URL(env.BARD_PUBLIC_API_URL || (env.NODE_ENV !== 'production' ? `http://localhost:${env.PORT || 4000}` : ''));
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
    return url.origin;
  } catch {
    throw failure(503, 'Configure a secure BARD_PUBLIC_API_URL.');
  }
}

export const humanLinkSchema = [
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS human_owner_wallet TEXT`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS human_link_version INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS agent_human_links (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('ethos','passport')),
    wallet TEXT NOT NULL,
    assurance JSONB NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS human_link_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    challenge JSONB,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS human_link_sessions_agent ON human_link_sessions(agent_id)`,
];

export async function getHumanLinks(pool, agentId) {
  const { rows } = await pool.query('SELECT provider,wallet,assurance,verified_at FROM agent_human_links WHERE agent_id=$1 ORDER BY provider', [agentId]);
  return rows.map(row => ({ provider: row.provider, wallet: row.wallet, verifiedAt: row.verified_at, ...row.assurance,
    // Historical linkage persists, but an expired Passport must not look current.
    ...(row.provider === 'passport' ? { passed: row.assurance.passed === true && Date.parse(row.assurance.expiresAt) > Date.now() } : {}),
  }));
}

export function mountHumanLinkRoutes(app, { pool, requireAuth, requireOwnAgent, env = process.env, ethos = getOwnerAssurance, passport = getPassportAssurance }) {
  const configuredOrigin = () => humanLinkOrigin(env);
  const route = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Human verification is temporarily unavailable. Please try again.' }); }
  };
  const sessionFor = async req => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization') || '')?.[1];
    if (!token) throw failure(401, 'Open the verification link provided by your agent.');
    const { rows } = await pool.query(`SELECT s.*, a.agent_name, a.agent_public_key, a.turnkey_address, a.human_link_version
      FROM human_link_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.id=$1`, [hash(token)]);
    const session = rows[0];
    if (!session || session.used_at || Date.parse(session.expires_at) <= Date.now() || session.version !== session.human_link_version) throw failure(410, 'This link has expired or was already used. Ask your agent for a new link.');
    return session;
  };

  app.get('/verify-human', (_req, res) => {
    res.set({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile('index.html', { root: assetRoot });
  });
  for (const name of ['app.js', 'style.css']) app.get(`/human-link-assets/${name}`, (_req, res) => res.sendFile(name, { root: assetRoot }));

  app.post('/api/agents/:id/human-link-session', requireAuth, requireOwnAgent, route(async (req, res) => {
    const origin = configuredOrigin();
    const client = await pool.connect();
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + LIFETIME_MS).toISOString();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT human_link_version FROM agents WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!rows.length) throw failure(404, 'Agent not found.');
      await client.query('DELETE FROM human_link_sessions WHERE agent_id=$1 AND (expires_at < now() OR used_at IS NOT NULL)', [req.params.id]);
      const count = await client.query('SELECT count(*) FROM human_link_sessions WHERE agent_id=$1', [req.params.id]);
      if (Number(count.rows[0].count) >= 5) throw failure(429, 'Use an existing verification link or wait for it to expire.');
      await client.query('INSERT INTO human_link_sessions (id,agent_id,version,expires_at) VALUES ($1,$2,$3,$4)', [hash(token), req.params.id, rows[0].human_link_version, expiresAt]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    res.json({ agentId: req.params.id, verificationUrl: `${origin}/verify-human#${token}`, expiresAt, message: 'Open this page to choose Ethos, Human Passport, or both, connect the human wallet, and sign the link. This link cannot authorize spending.' });
  }));

  app.get('/api/agents/:id/human-links', route(async (req, res) => {
    const agent = await pool.query('SELECT id FROM agents WHERE id=$1', [req.params.id]);
    if (!agent.rowCount) throw failure(404, 'Agent not found.');
    res.json({ agentId: req.params.id, links: await getHumanLinks(pool, req.params.id) });
  }));

  app.post('/api/agents/:id/unlink', requireAuth, requireOwnAgent, route(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const agent = await client.query(`UPDATE agents SET human_link_version=human_link_version+1,
        human_owner_wallet=NULL, ethos_owner_wallet=NULL WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!agent.rowCount) throw failure(404, 'Agent not found.');
      await client.query('DELETE FROM agent_human_links WHERE agent_id=$1', [req.params.id]);
      await client.query('DELETE FROM human_link_sessions WHERE agent_id=$1', [req.params.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    res.json({ success: true, agentId: req.params.id, links: [], message: 'Human links removed and pending verification links cancelled.' });
  }));

  app.get('/api/human-links/session', route(async (req, res) => {
    const session = await sessionFor(req);
    res.json({ agentId: session.agent_id, agentName: session.agent_name, expiresAt: session.expires_at,
      providers: { ethos: true, passport: passportConfigured(env) }, links: await getHumanLinks(pool, session.agent_id) });
  }));

  app.post('/api/human-links/challenge', route(async (req, res) => {
    const session = await sessionFor(req);
    const wallet = String(req.body?.wallet || '').toLowerCase();
    const providers = Array.isArray(req.body?.providers) ? [...new Set(req.body.providers)].sort() : [];
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || /^0x0+$/.test(wallet) || [session.agent_public_key, session.turnkey_address].some(a => a?.toLowerCase() === wallet)) throw failure(400, 'Connect the human’s wallet, separate from the agent’s signing wallet.');
    if (!providers.length || providers.some(p => !['ethos', 'passport'].includes(p))) throw failure(400, 'Choose Ethos, Human Passport, or both.');
    if (providers.includes('passport') && !passportConfigured(env)) throw failure(503, 'Human Passport is not configured on this Bard deployment yet.');
    const challenge = { id: randomBytes(32).toString('hex'), wallet, providers };
    challenge.message = ['Bard human-to-agent link', `Domain: ${configuredOrigin()}`, `Agent: ${session.agent_id}`, `Wallet: ${wallet}`, `Providers: ${providers.join(', ')}`, 'Purpose: link identity only. No transactions or spending permission.', `Nonce: ${challenge.id}`, `Expires: ${new Date(session.expires_at).toISOString()}`].join('\n');
    const update = await pool.query('UPDATE human_link_sessions SET challenge=$1 WHERE id=$2 AND used_at IS NULL AND expires_at > now() AND attempts < 10', [JSON.stringify(challenge), session.id]);
    if (!update.rowCount) throw failure(410, 'Request a new verification link.');
    res.json({ challengeId: challenge.id, message: challenge.message, wallet, providers });
  }));

  app.post('/api/human-links/complete', route(async (req, res) => {
    const session = await sessionFor(req);
    const challenge = session.challenge;
    if (!challenge || challenge.id !== req.body?.challengeId) throw failure(400, 'Request a new signing message on this page.');
    const attempt = await pool.query('UPDATE human_link_sessions SET attempts=attempts+1 WHERE id=$1 AND attempts < 10 AND used_at IS NULL RETURNING id', [session.id]);
    if (!attempt.rowCount) throw failure(429, 'Too many attempts. Request a new verification link.');
    let valid = false;
    try { valid = await verifyMessage({ address: challenge.wallet, message: challenge.message, signature: req.body?.signature }); } catch {}
    if (!valid) throw failure(403, 'The wallet signature does not match this request.');
    const assurances = [];
    for (const provider of challenge.providers) {
      if (provider === 'ethos') {
        const proof = await ethos(challenge.wallet, { force: true });
        if (!proof.available) throw failure(503, 'Ethos is temporarily unavailable. Please retry.');
        if (!proof.humanVerified && !proof.profile?.username && !proof.profile?.displayName) throw failure(403, 'No Ethos profile was found for this wallet. Connect the wallet linked to your Ethos account.');
        assurances.push({ provider, assurance: { source: 'ethos', profileLinked: true, humanVerified: proof.humanVerified === true, checkedAt: proof.checkedAt } });
      } else {
        const proof = await passport(challenge.wallet, { env });
        if (!proof.available) throw failure(503, 'Human Passport is temporarily unavailable. Please retry.');
        if (!proof.passed) throw failure(403, 'This Passport does not currently meet its score threshold, or has expired. Update your Passport and retry.');
        assurances.push({ provider, assurance: proof });
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT human_link_version,human_owner_wallet,ethos_owner_wallet FROM agents WHERE id=$1 FOR UPDATE', [session.agent_id]);
      const agent = rows[0];
      if (!agent || agent.human_link_version !== session.version) throw failure(409, 'The agent’s link changed. Request a new link.');
      const existingWallet = agent.human_owner_wallet || agent.ethos_owner_wallet;
      if (existingWallet && existingWallet.toLowerCase() !== challenge.wallet) throw failure(409, 'This agent is linked to another wallet. Ask the agent to unlink it first.');
      const used = await client.query("UPDATE human_link_sessions SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at > now() AND challenge->>'id'=$2 RETURNING id", [session.id, challenge.id]);
      if (!used.rowCount) throw failure(409, 'The link was consumed, expired, or its signing message changed.');
      for (const { provider, assurance } of assurances) await client.query(`INSERT INTO agent_human_links (agent_id,provider,wallet,assurance) VALUES ($1,$2,$3,$4)
        ON CONFLICT (agent_id,provider) DO UPDATE SET wallet=EXCLUDED.wallet,assurance=EXCLUDED.assurance,verified_at=now()`, [session.agent_id, provider, challenge.wallet, JSON.stringify(assurance)]);
      await client.query('UPDATE agents SET human_owner_wallet=$1, ethos_owner_wallet=CASE WHEN $2 THEN $1 ELSE ethos_owner_wallet END WHERE id=$3', [challenge.wallet, challenge.providers.includes('ethos'), session.agent_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    res.json({ success: true, agentId: session.agent_id, links: await getHumanLinks(pool, session.agent_id) });
  }));
}
