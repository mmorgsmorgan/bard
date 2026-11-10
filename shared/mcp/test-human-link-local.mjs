import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { startHumanLinkPage } from './human-link/local-page.js';

const token = 'a'.repeat(64);
const calls = [];
let remoteOrigin;
const session = () => ({ agentId: 'test-agent', verificationUrl: `${remoteOrigin}/verify-human#${token}`, expiresAt: new Date(Date.now() + 60000).toISOString(), mode: 'hosted' });
const remote = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/mcp') {
    assert.equal(req.headers.authorization, 'Bearer agent-test-credential');
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(session()) }] } }));
  }
  calls.push({ url: req.url, headers: req.headers, body });
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  if (req.url.endsWith('/complete')) return res.end(JSON.stringify({ success: true, links: [] }));
  res.end(JSON.stringify({ agentName: 'Test Agent', providers: { ethos: true, passport: true } }));
});
remote.listen(0, '127.0.0.1');
await once(remote, 'listening');
remoteOrigin = `http://127.0.0.1:${remote.address().port}`;
let page;
let child;
function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
try {
  await assert.rejects(startHumanLinkPage({ ...session(), verificationUrl: 'file:///tmp/secret' }), /Invalid/);
  await assert.rejects(startHumanLinkPage({ ...session(), expiresAt: '2000-01-01' }), /expired/);
  page = await startHumanLinkPage(session(), { openBrowser: true, launch: async () => false });
  assert.equal(page.browserOpened, false);
  const url = new URL(page.verificationUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const origin = url.origin;
  const auth = { Authorization: `Bearer ${token}` };
  const html = await fetch(origin + '/verify-human');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await html.text()).includes(token), false);
  assert.equal((await fetch(origin + '/human-link-assets/app.js')).status, 200);
  assert.equal((await fetch(origin + '/api/human-links/session')).status, 401);
  assert.equal(await rawStatus(origin + '/api/human-links/session', { ...auth, Host: 'attacker.example' }), 403);
  assert.equal((await fetch(origin + '/api/human-links/session', { headers: { ...auth, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(origin + '/api/agents/test-agent/wallet', { headers: auth })).status, 404);
  assert.equal((await fetch(origin + '/api/human-links/session?target=/wallet', { headers: auth })).status, 404);
  assert.equal(calls.length, 0, 'reject unauthorized requests before forwarding');
  assert.equal((await fetch(origin + '/api/human-links/session', { headers: auth })).status, 200);
  const post = { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(origin + '/api/human-links/challenge', post)).status, 403);
  assert.equal((await fetch(origin + '/api/human-links/challenge', { ...post, headers: { ...post.headers, Origin: origin } })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls).includes('agent-test-credential'), false);
  const closed = once(page.server, 'close');
  await fetch(origin + '/api/human-links/complete', { ...post, headers: { ...post.headers, Origin: origin } });
  await closed;
  assert.equal(page.server.listening, false);

  child = spawn(process.execPath, ['mcp/server.js'], {
    cwd: new URL('../../', import.meta.url),
    env: { PATH: process.env.PATH, BARD_TOKEN: 'agent-test-credential', BARD_MCP_URL: remoteOrigin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let buffer = Buffer.alloc(0);
  const responses = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + length) break;
      const rpc = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      responses.get(rpc.id)?.(rpc);
    }
  });
  let id = 0;
  async function rpc(mode) {
    const requestId = ++id;
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP adapter timeout: ${stderr}`)), 5000);
      responses.set(requestId, value => { clearTimeout(timer); responses.delete(requestId); resolve(value); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'bard_link_human', arguments: { mode, openBrowser: false } } }) + '\n');
    const reply = await received;
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return JSON.parse(reply.result.content[0].text);
  }
  const hosted = await rpc('hosted');
  assert.equal(hosted.verificationUrl, session().verificationUrl);
  const local = await rpc('auto');
  assert.equal(local.mode, 'local');
  assert.notEqual(local.verificationUrl, hosted.verificationUrl);
  assert.equal(local.hostedVerificationUrl, hosted.verificationUrl);
  assert.equal((await fetch(new URL(local.verificationUrl).origin + '/verify-human')).status, 200);
  assert.equal(stderr.includes(token), false);
  console.log('Local page proxy boundaries, browser fallback, automatic closure and stdio local/hosted selection passed.');
} finally {
  if (child) { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); }
  if (page) await page.close();
  await new Promise(resolve => remote.close(resolve));
}
