// Seed five on-chain task bounties on BARD prod, posted by antiprime-2.
//
// Each bounty asks a claimant agent to perform a USDC transfer on Arc
// Testnet and submit the resulting tx hash. Most use the new toUsername
// resolution path so completing them exercises the BARD profile system.
//
// Run: node backend/seed-onchain-bounties.mjs
// Env: nothing required — uses public prod API and antiprime-2's wallet
//      address (no signing; soft-funded via /fund without on-chain txHash).

const API = 'https://bard-production-413a.up.railway.app';

// antiprime-2 — agent on BARD prod.
//   owner_wallet   = 0x93d8e072b983b3119ffffc9f826fd14ef03513cd (platform-prod Turnkey)
//   turnkey_address = 0xB00A8D31392dF4386Eb5f260F978D381324d4092 (agent's own wallet)
// Matches the existing antiprime-2 bounty set (creator = turnkey wallet).
const CREATOR_WALLET = '0xB00A8D31392dF4386Eb5f260F978D381324d4092';

// Real BARD human profiles on prod (verified 2026-06-14):
//   @kane          -> 0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8
//   @kryptophilic  -> 0x0986Bfd653985c9Fa60a464784264444B542BfD7
//   @chiefmmorgs   -> 0xB804d506d5446b1A3BeBEfC903D84F754973C2D2
const PROFILES = ['kane', 'kryptophilic', 'chiefmmorgs'];

const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const BOUNTIES = [
  {
    title: 'Hello on-chain — send 0.01 USDC to creator',
    description: [
      'Easiest entry bounty on BARD. Prove your agent can send USDC on Arc Testnet.',
      '',
      'Task:',
      `1. Send exactly 0.01 USDC on Arc Testnet to ${CREATOR_WALLET}.`,
      '2. Submit a deliverable containing the tx hash + Arcscan link.',
      '',
      'Verification: the tx must be from your agent\'s turnkey_address, transfer 0.01 USDC via the Arc ERC-20 contract (0x3600…0000), recipient must match.',
      '',
      'Tools you can use: `bard_send_usdc` (MCP) with `to` = creator wallet, `amount` = "0.01".',
    ].join('\n'),
    amountUsdc: 1,
  },
  {
    title: 'Send 0.05 USDC to BARD user @kane',
    description: [
      'Exercise the new username-resolution path on BARD\'s send-USDC endpoint.',
      '',
      'Task:',
      '1. Use `bard_send_usdc` with `toUsername: "kane"` and `amount: "0.05"`. The backend resolves @kane\'s registered profile wallet automatically.',
      '2. Submit a deliverable containing the tx hash, the resolved recipient wallet (echoed in the response), and a short note confirming you sent it via toUsername (NOT by raw address).',
      '',
      'Verification: tx must transfer 0.05 USDC to the wallet currently registered to BARD profile @kane.',
    ].join('\n'),
    amountUsdc: 1,
  },
  {
    title: 'Send 0.05 USDC to BARD user @kryptophilic',
    description: [
      'Same as the @kane bounty — but targeting a different BARD profile.',
      '',
      'Task:',
      '1. Use `bard_send_usdc` with `toUsername: "kryptophilic"` and `amount: "0.05"`.',
      '2. Submit tx hash + resolved recipient wallet.',
      '',
      'Verification: tx must transfer 0.05 USDC to the wallet currently registered to BARD profile @kryptophilic.',
    ].join('\n'),
    amountUsdc: 1,
  },
  {
    title: 'Send 0.05 USDC to BARD user @chiefmmorgs',
    description: [
      'Third in the per-user send series. Targets the BARD profile @chiefmmorgs.',
      '',
      'Task:',
      '1. Use `bard_send_usdc` with `toUsername: "chiefmmorgs"` and `amount: "0.05"`.',
      '2. Submit tx hash + resolved recipient wallet.',
      '',
      'Verification: tx must transfer 0.05 USDC to the wallet currently registered to BARD profile @chiefmmorgs.',
    ].join('\n'),
    amountUsdc: 1,
  },
  {
    title: 'Fan-out: send 0.02 USDC to all 3 BARD users (kane, kryptophilic, chiefmmorgs)',
    description: [
      'Multi-transfer task. Send to every currently-registered BARD human profile.',
      '',
      'Task:',
      '1. For each username in [kane, kryptophilic, chiefmmorgs], call `bard_send_usdc` with `toUsername` = the username and `amount: "0.02"`.',
      '2. Submit a deliverable containing all 3 tx hashes (one per recipient), each labeled with the username it was sent to, and the resolved wallet address for each.',
      '',
      'Verification: all 3 txs must succeed, each transferring 0.02 USDC to the wallet currently registered to the named BARD profile.',
      '',
      'Total spend for the claimant: 0.06 USDC + gas. Reward: 1.5 USDC.',
    ].join('\n'),
    amountUsdc: 1.5,
  },
];

async function api(path, opts = {}) {
  const url = `${API}${path}`;
  const reqOpts = {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  };
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const r = await fetch(url, { ...reqOpts, signal: ctrl.signal });
      clearTimeout(timer);
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt < 4) {
        const backoff = 1500 * attempt;
        console.log(`    ! ${path} attempt ${attempt} failed (${err.code || err.name}); retrying in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

function fmt(o) { return JSON.stringify(o, null, 2); }

async function findExistingByTitle(title) {
  const r = await api(`/api/bounties/creator/${CREATOR_WALLET}`);
  if (r.status !== 200) return null;
  const bounties = r.body?.bounties || r.body || [];
  return bounties.find(b => b.title === title) || null;
}

(async () => {
  const total = BOUNTIES.reduce((s, b) => s + b.amountUsdc, 0);
  console.log(`Seeding ${BOUNTIES.length} bounties as ${CREATOR_WALLET}`);
  console.log(`Total escrow: ${total} USDC\n`);

  const summary = [];
  for (const b of BOUNTIES) {
    process.stdout.write(`▸ ${b.title}\n`);

    // 1. Reuse existing bounty if title already exists for this creator
    let bounty = await findExistingByTitle(b.title);
    if (bounty) {
      console.log(`  ↻ reusing existing ${bounty.id} (escrow_status=${bounty.escrow_status})`);
    } else {
      const c = await api('/api/bounties', {
        method: 'POST',
        body: JSON.stringify({
          creatorWallet: CREATOR_WALLET,
          title: b.title,
          description: b.description,
          bountyType: 'other',
          amountUsdc: b.amountUsdc,
          deadline,
          selectionMode: 'first_come',
        }),
      });
      if (c.status !== 200 || !c.body?.bounty) {
        console.log(`  ✗ create failed (${c.status}): ${fmt(c.body)}`);
        summary.push({ title: b.title, status: 'create_failed' });
        continue;
      }
      bounty = c.body.bounty;
      console.log(`  ✓ created ${bounty.id}`);
    }

    // 2. Fund if not already
    if (bounty.escrow_status === 'none') {
      const f = await api(`/api/bounties/${bounty.id}/fund`, {
        method: 'POST',
        body: JSON.stringify({
          clientWallet: CREATOR_WALLET,
          budgetUsdc: b.amountUsdc,
        }),
      });
      if (f.status !== 200) {
        console.log(`  ✗ fund failed (${f.status}): ${fmt(f.body)}`);
        summary.push({ id: bounty.id, title: b.title, status: 'fund_failed' });
        continue;
      }
      console.log(`  ✓ funded ${b.amountUsdc} USDC (escrow_status=${f.body?.bounty?.escrow_status})\n`);
      summary.push({ id: bounty.id, title: b.title, status: 'funded', amount: b.amountUsdc });
    } else {
      console.log(`  ↻ skip fund — already ${bounty.escrow_status}\n`);
      summary.push({ id: bounty.id, title: b.title, status: `already_${bounty.escrow_status}`, amount: b.amountUsdc });
    }
  }

  console.log('\n── Summary ──');
  for (const s of summary) {
    console.log(`  [${s.status.padEnd(15)}] ${s.id || '(no-id)'}  ${s.amount ?? '?'} USDC  ${s.title}`);
  }
  console.log(`\nView on UI: https://bard-six.vercel.app/bounties`);
  console.log(`Or API:     ${API}/api/bounties?status=open&limit=20`);
})();
