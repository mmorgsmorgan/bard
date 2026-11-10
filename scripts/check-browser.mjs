// Optional Playwright verification with provider fixtures and disposable keys.
// Build the frontend with the fixture API/MCP URLs described in README.md first.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.BARD_PLAYWRIGHT_MODULE || 'playwright');
import { humanLinkSchema, mountHumanLinkRoutes, getHumanLinks } from '../backend/human-link.js';
import { startHumanLinkPage } from '../shared/mcp/human-link/local-page.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(`${root}/package.json`);
const express = require('express');
const { Pool } = require('pg');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const database = process.env.BARD_TEST_DATABASE_URL;
if (!database) throw new Error('Set an isolated BARD_TEST_DATABASE_URL.');
const schema = `browser_${randomBytes(8).toString('hex')}`;
const admin = new Pool({ connectionString: database });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
const owner = privateKeyToAccount(generatePrivateKey());
const alternate = privateKeyToAccount(generatePrivateKey());
const agentWallet = '0x1111111111111111111111111111111111111111';
const apiOrigin = 'http://127.0.0.1:45550';
const webOrigin = 'http://127.0.0.1:3105';
const env = { NODE_ENV: 'test', BARD_PUBLIC_API_URL: apiOrigin, PASSPORT_API_KEY: 'test-only', PASSPORT_SCORER_ID: '123' };
const app = express();
app.use(express.json());
const requireAuth = (req, res, next) => {
  if (req.get('Authorization') !== 'Bearer browser-test-agent') return res.sendStatus(401);
  req.auth = { agentId: req.params.id };
  next();
};
let hasPassport = true;
mountHumanLinkRoutes(app, { pool, requireAuth, requireOwnAgent: (_req, _res, next) => next(), env,
  ethos: async () => ({ available: true, profile: { username: 'test-human' }, humanVerified: false, checkedAt: new Date().toISOString() }),
  passport: async () => ({ source: 'passport', available: true, passed: hasPassport, score: hasPassport ? 30 : 10, threshold: 20, expiresAt: new Date(Date.now() + 86400000).toISOString() }),
});
const entries = [{ id: 'design-agent', agentName: 'Design agent', description: 'Design and implement accessible interfaces.', reputationScore: 42, totalContributions: 7, availability: 'available', specializations: ['interface_design'] }];
const bounties = [{ id: 'design-bounty', title: 'Build an accessible interface', description: 'Create a responsive, keyboard accessible public page.', amount_usdc: '15', bounty_type: 'design', status: 'proposal_open' }];
let listing = 'populated';
app.get('/api/agents', (_req, res) => listing === 'unavailable' ? res.status(503).json({ error: 'Fixture outage' }) : res.json({ agents: listing === 'empty' ? [] : entries }));
app.get('/api/agents/:id', async (req, res) => req.params.id === entries[0].id ? res.json({ agent: entries[0], humanLinks: await getHumanLinks(pool, entries[0].id), ownerAssurance: { humanVerified: false } }) : res.status(404).json({ error: 'Not found' }));
app.get('/api/bounties', (_req, res) => res.json({ bounties }));
app.get('/api/bounties/:id', (req, res) => req.params.id === bounties[0].id ? res.json({ bounty: bounties[0] }) : res.status(404).json({ error: 'Not found' }));
let server, next, browser;
const localPages = [];
const browserErrors = [];
let serverLog = '';
const artifactDir = `${root}/agent-handoff/previews`;
async function createSession(id) {
  await pool.query('INSERT INTO agents (id,agent_name,agent_public_key,turnkey_address,owner_wallet,reputation_score) VALUES ($1,$1,$2,$2,$2,42) ON CONFLICT DO NOTHING', [id, agentWallet]);
  const response = await fetch(`${apiOrigin}/api/agents/${id}/human-link-session`, { method: 'POST', headers: { Authorization: 'Bearer browser-test-agent', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  return response.json();
}
async function walletPage({ width = 390, wallet = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  let account = owner;
  let rejectNext = false;
  const signed = [];
  await context.exposeBinding('__bardTestWallet', async (_source, method, params) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account.address];
    assert.equal(method, 'personal_sign', 'the page must never request a transaction or token approval');
    if (rejectNext) { rejectNext = false; return { rejected: true }; }
    assert.equal(params[1].toLowerCase(), account.address.toLowerCase());
    signed.push(Buffer.from(params[0].slice(2), 'hex').toString());
    return account.signMessage({ message: { raw: params[0] } });
  });
  if (wallet) await context.addInitScript(() => {
    const listeners = new Set();
    const provider = {
      request: async ({ method, params }) => {
        const result = await window.__bardTestWallet(method, params);
        if (result?.rejected) throw Object.assign(new Error('User rejected'), { code: 4001 });
        return result;
      },
      on: (event, fn) => { if (event === 'accountsChanged') listeners.add(fn); },
      removeListener: (event, fn) => { if (event === 'accountsChanged') listeners.delete(fn); },
    };
    window.ethereum = provider;
    window.__switchTestAccount = () => { for (const listener of listeners) listener([]); };
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Test wallet' }, provider } }));
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  return { context, page, signed, reject: () => { rejectNext = true; }, switch: () => { account = alternate; } };
}
try {
  await pool.query('CREATE TABLE agents (id TEXT PRIMARY KEY, agent_name TEXT, agent_public_key TEXT, turnkey_address TEXT, owner_wallet TEXT NOT NULL, ethos_owner_wallet TEXT, reputation_score INTEGER)');
  for (const statement of humanLinkSchema) await pool.query(statement);
  server = app.listen(45550, '127.0.0.1');
  await once(server, 'listening');
  next = spawn(process.execPath, [`${root}/node_modules/next/dist/bin/next`, 'start', '--hostname', '127.0.0.1', '--port', '3105'], {
    cwd: `${root}/frontend`,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_PUBLIC_API_URL: apiOrigin, NEXT_PUBLIC_MCP_URL: 'http://127.0.0.1:45552/mcp' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  next.stdout.on('data', data => { serverLog += data; });
  next.stderr.on('data', data => { serverLog += data; });
  for (let retry = 0; retry < 100; retry++) {
    if (next.exitCode !== null) throw new Error(`Next exited: ${serverLog}`);
    try { if ((await fetch(webOrigin)).ok) break; } catch {}
    if (retry === 99) throw new Error(`Next startup timeout: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.BARD_CHROMIUM_EXECUTABLE, headless: true });
  await mkdir(artifactDir, { recursive: true });

  // Real signatures traverse the browser, the real routes and isolated PostgreSQL.
  for (const [id, providers, local, width] of [['design-agent', ['ethos', 'passport'], false, 1440], ['passport-agent', ['passport'], true, 390], ['ethos-agent', ['ethos'], false, 320]]) {
    const session = await createSession(id);
    const verification = local ? await startHumanLinkPage(session) : session;
    if (local) localPages.push(verification);
    const state = await walletPage({ width });
    await state.page.goto(verification.verificationUrl);
    await state.page.locator('#connect:enabled').waitFor();
    assert.equal(new URL(state.page.url()).hash, '', 'remove the capability from the visible URL');
    await state.page.locator('input[value=ethos]').setChecked(providers.includes('ethos'));
    await state.page.locator('input[value=passport]').setChecked(providers.includes('passport'));
    await state.page.locator('#connect').click();
    await state.page.locator('#sign:visible').waitFor();
    await state.page.locator('#message-preview').evaluate(element => { element.open = true; });
    assert.ok((await state.page.locator('#message').textContent()).includes(`Agent: ${id}`));
    assert.ok(await state.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `verification overflow at ${width}`);
    await state.page.screenshot({ path: `${artifactDir}/human-link-${local ? 'mobile' : width === 1440 ? 'desktop' : 'small'}.png`, fullPage: true });
    if (id === 'design-agent') {
      state.reject();
      await state.page.locator('#sign').click();
      await state.page.getByRole('status').filter({ hasText: 'Signature cancelled' }).waitFor();
      assert.equal((await getHumanLinks(pool, id)).length, 0);
    }
    await state.page.locator('#sign').click();
    await state.page.getByRole('status').filter({ hasText: 'You can close this page' }).waitFor();
    assert.equal(state.signed.length, 1);
    assert.deepEqual((await getHumanLinks(pool, id)).map(link => link.provider), providers.slice().sort());
    const record = (await pool.query('SELECT owner_wallet,human_owner_wallet,reputation_score FROM agents WHERE id=$1', [id])).rows[0];
    assert.equal(record.owner_wallet, agentWallet);
    assert.equal(record.human_owner_wallet, owner.address.toLowerCase());
    assert.equal(record.reputation_score, 42);
    await state.context.close();
  }

  const switched = await walletPage();
  const switchSession = await createSession('switch-agent');
  await switched.page.goto(switchSession.verificationUrl);
  await switched.page.locator('#connect:enabled').waitFor();
  await switched.page.locator('#connect').click();
  await switched.page.locator('#sign:visible').waitFor();
  switched.switch();
  await switched.page.evaluate(() => window.__switchTestAccount());
  assert.equal(await switched.page.locator('#sign').isVisible(), false);
  await switched.page.locator('#connect').click();
  await switched.page.locator('#sign:visible').waitFor();
  await switched.page.locator('#sign').click();
  await switched.page.getByRole('status').filter({ hasText: 'Linked with Ethos' }).waitFor();
  assert.equal((await getHumanLinks(pool, 'switch-agent'))[0].wallet, alternate.address.toLowerCase());
  await switched.context.close();

  const missing = await walletPage({ wallet: false });
  await missing.page.goto((await createSession('no-wallet-agent')).verificationUrl);
  await missing.page.locator('#connect:enabled').waitFor();
  await missing.page.locator('#connect').click();
  await missing.page.getByRole('status').filter({ hasText: 'No browser wallet was found' }).waitFor();
  await missing.page.goto(`${apiOrigin}/verify-human`);
  await missing.page.getByRole('status').filter({ hasText: 'Ask your agent' }).waitFor();
  assert.equal(await missing.page.locator('#connect').isDisabled(), true);
  await missing.context.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(webOrigin, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${artifactDir}/home-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Copy endpoint' }).click();
  await page.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'http://127.0.0.1:45552/mcp');
  for (const path of ['/agents', '/agents/design-agent', '/bounties', '/bounties/design-bounty']) {
    assert.equal((await page.goto(webOrigin + path)).status(), 200);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.getByText('temporarily unavailable', { exact: false }).count(), 0);
    if (path === '/agents/design-agent') {
      await page.getByText('Human Passport score passed', { exact: true }).waitFor();
      assert.equal(await page.getByText('Verified Human', { exact: false }).count(), 0, 'social linkage must not imply explicit verification');
    }
  }
  assert.equal((await page.goto(`${webOrigin}/agents/missing`)).status(), 404);
  for (const retired of ['/profile', '/dashboard', '/send', '/leaderboard']) assert.equal((await page.goto(webOrigin + retired)).status(), 404);
  listing = 'empty';
  await page.goto(`${webOrigin}/agents`);
  await page.getByRole('heading', { name: 'Make the first introduction.' }).waitFor();
  listing = 'unavailable';
  await page.goto(`${webOrigin}/agents`);
  await page.getByRole('heading', { name: 'The directory is temporarily unavailable.' }).waitFor();
  listing = 'populated';
  await page.getByRole('link', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'Design agent' }).waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/agents', '/bounties/design-bounty']) {
      await page.goto(webOrigin + path, { waitUntil: 'networkidle' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width} on ${path}`);
      if (width === 390 && path === '/') await page.screenshot({ path: `${artifactDir}/home-mobile.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  await context.close();
  assert.deepEqual(browserErrors, []);
  console.log('Browser verification passed: desktop/mobile, listings/details/empty/error/retry/404, copy, reduced motion, hosted/local Ethos/Passport/both, signature cancellation/retry, account switch, missing wallet/link, real signatures and reputation isolation.');
} finally {
  if (browser) await browser.close();
  for (const page of localPages) await page.close();
  if (next && next.exitCode === null) { next.kill('SIGTERM'); await once(next, 'exit'); }
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
