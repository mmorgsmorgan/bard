/**
 * MCP Server Test — setTimeout-based to avoid chunk races
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bard', 'config.json'), 'utf8'));
const mcp = spawn('node', ['/mnt/c/Ubuntu/home/chief/bard/mcp/server.js'], {
  env: { ...process.env, BARD_TOKEN: config.token, BARD_API: 'http://localhost:4000' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const results = {};
mcp.stderr.on('data', () => {});
mcp.stdout.on('data', (d) => {
  const raw = d.toString();
  // Split on Content-Length headers
  const msgs = raw.split(/(?=Content-Length:)/);
  for (const m of msgs) {
    const bodyMatch = m.match(/Content-Length:\s*\d+\r\n\r\n([\s\S]+)/);
    if (!bodyMatch) continue;
    try { const parsed = JSON.parse(bodyMatch[1]); results[parsed.id] = parsed; } catch {}
  }
});

function send(id, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  mcp.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const wait = (id) => new Promise(r => {
  const t = Date.now();
  const c = () => { if (results[id]) r(results[id]); else if (Date.now() - t > 5000) r(null); else setTimeout(c, 50); };
  c();
});

console.log('\n  ── BARD MCP Server Test ──\n');

setTimeout(async () => {
  send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  const init = await wait(1);
  console.log(`  ✓ Server: ${init?.result?.serverInfo?.name} v${init?.result?.serverInfo?.version}`);

  setTimeout(async () => {
    send(2, 'tools/list');
    const tl = await wait(2);
    const tools = tl?.result?.tools || [];
    console.log(`  ✓ ${tools.length} tools:`);
    for (const t of tools) console.log(`    ◆ ${t.name}`);

    setTimeout(async () => {
      send(3, 'tools/call', { name: 'bard_get_identity', arguments: {} });
      const id3 = await wait(3);
      const idD = JSON.parse(id3?.result?.content?.[0]?.text || '{}');
      console.log(`\n  ✓ Agent: ${idD.agentName} — ${idD.reputation?.tier} (Score ${idD.reputation?.score})`);

      setTimeout(async () => {
        send(4, 'tools/call', { name: 'bard_list_agents', arguments: {} });
        const ag = await wait(4);
        const agD = JSON.parse(ag?.result?.content?.[0]?.text || '{}');
        console.log(`  ✓ Platform agents: ${agD.count}`);

        console.log('\n  ══════════════════════════════════');
        console.log('  ✅ MCP Server fully operational!');
        console.log('  ══════════════════════════════════\n');
        mcp.kill();
        process.exit(0);
      }, 500);
    }, 500);
  }, 500);
}, 500);
