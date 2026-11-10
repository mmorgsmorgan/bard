import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import { humanLinkSchema, mountHumanLinkRoutes } from './human-link.js';

const database = process.env.BARD_TEST_DATABASE_URL;
if (!database) throw new Error('Set an isolated BARD_TEST_DATABASE_URL.');
const schema = `human_link_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: database });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
const owner = privateKeyToAccount('0x' + '77'.repeat(32));
const other = privateKeyToAccount('0x' + '88'.repeat(32));
const agentWallet = '0x1111111111111111111111111111111111111111';
const env = { NODE_ENV: 'test', PASSPORT_API_KEY: 'test-only', PASSPORT_SCORER_ID: '123' };
let ethosProof = { available: true, profile: { username: 'human' }, humanVerified: false, checkedAt: new Date().toISOString() };
let passportProof = { source: 'passport', available: true, passed: true, score: 30, threshold: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() };
let ethosCalls = 0;
let pauseEthos;
let enteredEthos;
const app = express();
app.use(express.json());
const requireAuth = (req, res, next) => {
  const id = /^Bearer agent:(one|two|three)$/.exec(req.get('Authorization') || '')?.[1];
  if (!id) return res.status(401).json({ error: 'Agent credential required.' });
  req.auth = { agentId: id };
  next();
};
const requireOwnAgent = (req, res, next) => req.auth.agentId === req.params.id ? next() : res.status(403).json({ error: 'Not your agent.' });
mountHumanLinkRoutes(app, { pool, requireAuth, requireOwnAgent, env,
  ethos: async () => { ethosCalls++; enteredEthos?.(); if (pauseEthos) await pauseEthos; return ethosProof; },
  passport: async () => passportProof,
});
let server;
let origin;
async function call(path, body, token, extraHeaders = {}) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function session(id = 'one') {
  const result = await call(`/api/agents/${id}/human-link-session`, {}, `agent:${id}`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const url = new URL(result.data.verificationUrl);
  assert.equal(url.search, '');
  assert.match(url.hash, /^#[a-f0-9]{64}$/);
  return url.hash.slice(1);
}
async function challenge(token, providers = ['ethos'], wallet = owner) {
  const result = await call('/api/human-links/challenge', { wallet: wallet.address, providers }, token);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.data.message, /No transactions or spending permission/);
  return { ...result.data, signature: await wallet.signMessage({ message: result.data.message }) };
}
const complete = (token, proof) => call('/api/human-links/complete', { challengeId: proof.challengeId, signature: proof.signature }, token);
const links = id => call(`/api/agents/${id}/human-links`);

try {
  await pool.query(`CREATE TABLE agents (id TEXT PRIMARY KEY, agent_name TEXT, agent_public_key TEXT,
    turnkey_address TEXT, owner_wallet TEXT NOT NULL, ethos_owner_wallet TEXT, reputation_score INTEGER)`);
  for (let run = 0; run < 2; run++) for (const statement of humanLinkSchema) await pool.query(statement);
  for (const id of ['one', 'two', 'three']) await pool.query('INSERT INTO agents (id,agent_name,agent_public_key,turnkey_address,owner_wallet,reputation_score) VALUES ($1,$1,$2,$2,$2,42)', [id, agentWallet]);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.BARD_PUBLIC_API_URL = origin;
  assert.equal((await call('/api/agents/one/human-link-session', {})).status, 401);
  assert.equal((await call('/api/agents/one/human-link-session', {}, 'agent:two')).status, 403);
  assert.equal((await links('missing')).status, 404);

  const token = await session();
  assert.equal((await pool.query('SELECT id FROM human_link_sessions WHERE id=$1', [token])).rowCount, 0, 'store only a hash of the browser token');
  assert.equal((await call('/api/human-links/session', undefined, 'agent:one')).status, 401);
  assert.equal((await call('/api/human-links/session', undefined, '0'.repeat(64))).status, 410);
  assert.equal((await call('/api/agents/one/unlink', {}, token)).status, 401, 'browser token has no agent authority');
  assert.equal((await call('/api/human-links/challenge', { wallet: agentWallet, providers: ['ethos'] }, token)).status, 400);
  assert.equal((await call('/api/human-links/challenge', { wallet: owner.address, providers: ['unknown'] }, token)).status, 400);
  const old = await challenge(token);
  const signed = await challenge(token);
  assert.equal((await complete(token, old)).status, 400);
  assert.equal((await complete(token, { ...signed, signature: old.signature })).status, 403);
  assert.equal(ethosCalls, 0, 'check signature before calling providers');
  const linked = await complete(token, signed);
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.links[0].profileLinked, true);
  assert.equal(linked.data.links[0].humanVerified, false, 'an Ethos profile is not explicit human verification');
  assert.equal((await complete(token, signed)).status, 410);
  const row = (await pool.query('SELECT * FROM agents WHERE id=$1', ['one'])).rows[0];
  assert.equal(row.human_owner_wallet, owner.address.toLowerCase());
  assert.equal(row.owner_wallet, agentWallet);
  assert.equal(row.reputation_score, 42);

  const mismatch = await session();
  assert.equal((await complete(mismatch, await challenge(mismatch, ['ethos'], other))).status, 409);
  const missingPassport = await session('two');
  delete env.PASSPORT_SCORER_ID;
  assert.equal((await call('/api/human-links/challenge', { wallet: owner.address, providers: ['passport'] }, missingPassport)).status, 503);
  env.PASSPORT_SCORER_ID = '123';
  passportProof = { ...passportProof, passed: false };
  const combined = await challenge(missingPassport, ['passport', 'ethos']);
  assert.equal((await complete(missingPassport, combined)).status, 403);
  assert.deepEqual((await links('two')).data.links, [], 'both selected providers must pass before storing either');
  passportProof = { ...passportProof, passed: true };
  ethosProof = { ...ethosProof, humanVerified: true };
  assert.equal((await complete(missingPassport, combined)).status, 200);
  assert.equal((await links('two')).data.links.length, 2);
  await pool.query(`UPDATE agent_human_links SET assurance=assurance || $1::jsonb WHERE agent_id='two' AND provider='passport'`, [JSON.stringify({ expiresAt: '2000-01-01T00:00:00Z' })]);
  assert.equal((await links('two')).data.links.find(l => l.provider === 'passport').passed, false);

  const concurrentToken = await session('three');
  const concurrentProof = await challenge(concurrentToken, ['passport']);
  assert.equal((await complete(concurrentToken, signed)).status, 400, 'challenge is bound to a session and agent');
  const outcomes = await Promise.all([complete(concurrentToken, concurrentProof), complete(concurrentToken, concurrentProof)]);
  assert.equal(outcomes.filter(r => r.status === 200).length, 1, 'only one completion can consume a link');
  assert.equal((await links('three')).data.links.length, 1);

  const pendingToken = await session('two');
  const pendingProof = await challenge(pendingToken);
  let release;
  pauseEthos = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enteredEthos = resolve; });
  const completing = complete(pendingToken, pendingProof);
  await entered;
  assert.equal((await call('/api/agents/two/unlink', {}, 'agent:two')).status, 200);
  release();
  assert.equal((await completing).status, 409, 'unlink must defeat an in-flight completion');
  pauseEthos = undefined;
  enteredEthos = undefined;
  assert.deepEqual((await links('two')).data.links, []);
  assert.equal((await call('/api/human-links/session', undefined, pendingToken)).status, 410);
  assert.equal((await pool.query("SELECT reputation_score FROM agents WHERE id='two'")).rows[0].reputation_score, 42);

  const expiringToken = await session('two');
  await pool.query("UPDATE human_link_sessions SET expires_at=now()-interval '1 second' WHERE agent_id='two'");
  const expired = (await call('/api/human-links/session', undefined, expiringToken));
  assert.equal(expired.status, 410);
  for (let i = 0; i < 5; i++) await session('two');
  assert.equal((await call('/api/agents/two/human-link-session', {}, 'agent:two')).status, 429);

  const html = await fetch(origin + '/verify-human');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await html.text()).includes(token), false);
  console.log('Human-link choices, signature/session binding, atomic completion, expiry, unlink races and reputation isolation passed.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
