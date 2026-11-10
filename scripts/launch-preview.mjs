import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateDir = path.join(os.homedir(), '.config', 'bard');
const configPath = path.join(privateDir, 'preview-20261110.json');
const postgresEnvPath = path.join(privateDir, 'preview-20261110-postgres.env');
const statePath = path.join(privateDir, 'preview-20261110-state.json');
const dataDir = path.join(os.homedir(), '.local', 'share', 'bard-preview-20261110');
const container = 'bard-preview-20261110';
const previewLabel = 'bard-preview-20261110';
const admin = '0xB804d506d5446b1A3BeBEfC903D84F754973C2D2';
const baseEnv = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']
    .filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]),
);
const children = [];
let closing = false;

function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: baseEnv, stdio: 'inherit', ...options });
  children.push(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', (code, signal) => {
    if (!closing) {
      console.error(`Preview process exited (${code ?? signal}).`);
      stop(code || 1);
    }
  });
  return child;
}

async function waitFor(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !closing) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* Service is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Preview did not become ready: ${url}`);
}

try {
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = Object.fromEntries(['postgresPassword', 'jwtSecret', 'walletMasterKey', 'mcpSecret', 'operatorSecret']
      .map(key => [key, randomBytes(32).toString('hex')]));
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  }
  await chmod(configPath, 0o600);
  await writeFile(postgresEnvPath, `POSTGRES_DB=bard_preview\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${config.postgresPassword}\n`, { mode: 0o600 });
  await chmod(postgresEnvPath, 0o600);

  let exists = false;
  try {
    const result = await exec('docker', ['inspect', '--format', '{{index .Config.Labels "com.bard.preview"}}', container]);
    if (result.stdout.trim() !== previewLabel) throw new Error('Refusing to reuse an unrelated database container.');
    exists = true;
  } catch (error) {
    if (!/no such (object|container)/i.test(String(error.stderr || ''))) throw error;
  }
  console.log('Starting the isolated preview database…');
  if (exists) await exec('docker', ['start', container]);
  else await exec('docker', ['run', '-d', '--name', container, '--label', `com.bard.preview=${previewLabel}`,
    '-p', '127.0.0.1:55440:5432', '--env-file', postgresEnvPath,
    '-v', 'bard-preview-20261110-data:/var/lib/postgresql/data', 'postgres:16']);
  for (let attempt = 0; ; attempt++) {
    try { await exec('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'bard_preview']); break; }
    catch (error) {
      if (attempt >= 45) throw new Error('Preview database did not become ready.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  let publicUrl = 'http://localhost:3000';
  if (process.argv.includes('--public')) {
    console.log('Opening a sign-in-free preview tunnel…');
    await chmod('/tmp/bard-cloudflared-linux-amd64', 0o700);
    const tunnel = start('/tmp/bard-cloudflared-linux-amd64', ['tunnel', '--config', '/dev/null', '--no-autoupdate',
      '--protocol', 'http2', '--url', 'http://127.0.0.1:3000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    publicUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview tunnel did not provide a URL.')), 45_000);
      let output = '';
      const inspect = chunk => {
        output += chunk.toString();
        const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (url) { clearTimeout(timer); resolve(url[0]); }
      };
      tunnel.stdout.on('data', inspect);
      tunnel.stderr.on('data', inspect);
      tunnel.once('exit', () => { clearTimeout(timer); reject(new Error('Preview tunnel stopped before startup.')); });
    });
  }

  const cors = [...new Set(['http://localhost:3000', 'http://127.0.0.1:3000', publicUrl])].join(',');
  const common = { ...baseEnv, NODE_ENV: 'development', DOTENV_CONFIG_PATH: '/dev/null', CORS_ORIGIN: cors };
  const api = start(process.execPath, ['backend/server.js'], { env: {
    ...common, PORT: '4000', DATABASE_URL: `postgres://postgres:${config.postgresPassword}@127.0.0.1:55440/bard_preview`,
    JWT_SECRET: config.jwtSecret, WALLET_PROVIDER: 'local', WALLET_MASTER_KEY: config.walletMasterKey,
    MCP_INTERNAL_SECRET: config.mcpSecret, PLATFORM_OPERATOR_SECRET: config.operatorSecret, MCP_ONLY_AGENT_API: 'true',
    DATA_DIR: dataDir, UPLOADS_DIR: path.join(dataDir, 'uploads'), BARD_PUBLIC_API_URL: publicUrl, MCP_URL: publicUrl,
    SELLER_ADDRESS: admin, PLATFORM_OWNER_WALLET: admin, SECURE_ADMIN: admin,
    ONCHAIN_ESCROW: 'true', AGENTIC_COMMERCE_ADDRESS: '0x680e73Ff53981629b8B814cE9A69AD1347867606',
    BARD_JOB_HOOK_ADDRESS: '0x097eF956B18E20A8E9b509791c2a430b2750f32b',
    USDC_CONTRACT_ADDRESS: '0x3600000000000000000000000000000000000000',
    ARC_TESTNET_RPC: 'https://rpc.testnet.arc.network', BARD_VCR_POLICIES: '{}',
  } });
  await waitFor('http://127.0.0.1:4000/api/health');
  console.log('Preview API ready.');

  const mcp = start(process.execPath, ['mcp-server/server.js'], { env: {
    ...common, PORT: '4100', BARD_API: 'http://127.0.0.1:4000', MCP_INTERNAL_SECRET: config.mcpSecret, SELLER_ADDRESS: admin,
  } });
  await waitFor('http://127.0.0.1:4100/health');
  console.log('Preview MCP ready.');

  const require = createRequire(import.meta.url);
  const next = require.resolve('next/dist/bin/next', { paths: [path.join(root, 'frontend')] });
  const web = start(process.execPath, [next, 'dev', '--hostname', '0.0.0.0', '--port', '3000'], {
    cwd: path.join(root, 'frontend'), env: {
      ...baseEnv, NODE_ENV: 'development', NEXT_PUBLIC_API_URL: '', NEXT_PUBLIC_MCP_URL: `${publicUrl}/mcp`,
      BARD_PREVIEW_API_ORIGIN: 'http://127.0.0.1:4000', BARD_PREVIEW_MCP_ORIGIN: 'http://127.0.0.1:4100',
      BARD_PREVIEW_HOST: new URL(publicUrl).hostname,
    },
  });
  await waitFor('http://127.0.0.1:3000');
  await writeFile(statePath, JSON.stringify({ launcherPid: process.pid, apiPid: api.pid, mcpPid: mcp.pid, webPid: web.pid,
    childPids: children.map(child => child.pid), container, publicUrl, localUrl: 'http://localhost:3000',
    startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`\nBard preview ready: ${publicUrl}\nLocal: http://localhost:3000\nFresh preview database: ${container}\n`);
} catch (error) {
  console.error(error.message);
  stop(1);
}
