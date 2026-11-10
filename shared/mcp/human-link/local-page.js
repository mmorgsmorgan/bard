import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const assets = new Map([
  ['/verify-human', ['index.html', 'text/html; charset=utf-8']],
  ['/human-link-assets/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/human-link-assets/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const apiMethods = new Map([
  ['/api/human-links/session', 'GET'],
  ['/api/human-links/challenge', 'POST'],
  ['/api/human-links/complete', 'POST'],
]);
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function openDefaultBrowser(url) {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'rundll32.exe'
      : process.env.WSL_DISTRO_NAME ? 'wslview' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    // The URL is constructed locally, contains only a port and hex capability,
    // and is passed as an argument without a shell. Never log it to stderr.
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 4000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Serve one identity session on loopback, with no agent token in the page. */
export async function startHumanLinkPage(session, { fetchImpl = globalThis.fetch, openBrowser = false, launch = openDefaultBrowser } = {}) {
  const remote = new URL(session.verificationUrl);
  const token = remote.hash.slice(1);
  const loopback = ['127.0.0.1', 'localhost'].includes(remote.hostname);
  if (remote.username || remote.password || remote.search || remote.pathname !== '/verify-human'
    || !/^[a-f0-9]{64}$/.test(token)
    || !(remote.protocol === 'https:' || (remote.protocol === 'http:' && loopback))) {
    throw new Error('Invalid Bard verification URL.');
  }
  const remaining = Date.parse(session.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Verification link has expired.');
  const authorization = Buffer.from(`Bearer ${token}`);
  let origin;
  let expiryTimer;
  let completionTimer;
  const reply = (res, code, data) => {
    res.writeHead(code, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      // Check Host as well as Origin: loopback binding alone does not prevent
      // DNS rebinding or requests from unrelated browser tabs.
      if (req.headers.host !== new URL(origin).host || url.origin !== origin
        || (req.headers.origin && req.headers.origin !== origin)) {
        return reply(res, 403, { error: 'Open this page on its original local address.' });
      }
      if (Date.now() >= Date.parse(session.expiresAt)) return reply(res, 410, { error: 'Verification link expired.' });
      if (req.method === 'GET' && assets.has(url.pathname) && !url.search) {
        const [name, contentType] = assets.get(url.pathname);
        const body = await readFile(new URL(name, import.meta.url));
        res.writeHead(200, { ...headers, 'Content-Type': contentType });
        return res.end(body);
      }
      if (apiMethods.get(url.pathname) !== req.method || url.search) return reply(res, 404, { error: 'Not found.' });
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        return reply(res, 401, { error: 'Open the verification link provided by your agent.' });
      }
      if (req.method === 'POST' && req.headers.origin !== origin) return reply(res, 403, { error: 'Request must come from this verification page.' });
      let body;
      if (req.method === 'POST') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return reply(res, 415, { error: 'JSON required.' });
        if (Number(req.headers['content-length']) > 16384) return reply(res, 413, { error: 'Request too large.' });
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 16384) return reply(res, 413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        try { body = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { return reply(res, 400, { error: 'Invalid JSON.' }); }
      }
      // Fixed origin and three fixed paths. This is not a general API proxy.
      const response = await fetchImpl(`${remote.origin}${url.pathname}`, {
        method: req.method,
        headers: { Authorization: authorization.toString(), 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
        redirect: 'error', signal: AbortSignal.timeout(25000),
      });
      const data = await response.json();
      reply(res, response.status, data);
      if (url.pathname.endsWith('/complete') && response.ok && data.success) {
        completionTimer = setTimeout(() => { void close(); }, 1000);
        completionTimer.unref();
      }
    } catch {
      if (!res.headersSent) reply(res, 502, { error: 'Bard verification is temporarily unavailable. Retry or use the hosted link.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    clearTimeout(expiryTimer);
    clearTimeout(completionTimer);
    await new Promise(resolve => server.close(resolve));
  }
  expiryTimer = setTimeout(() => { void close(); }, Math.min(remaining, 15 * 60_000));
  expiryTimer.unref();
  server.unref();
  const verificationUrl = `${origin}/verify-human#${token}`;
  let browserOpened = false;
  if (openBrowser) {
    try { browserOpened = await launch(verificationUrl); } catch { /* Return a usable URL. */ }
  }
  return { verificationUrl, hostedVerificationUrl: session.verificationUrl, mode: 'local', browserOpened, close, server };
}
