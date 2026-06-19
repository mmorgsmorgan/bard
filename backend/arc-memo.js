/**
 * arc-memo.js — Arc transaction-memo wrapper for BARD's on-chain writes.
 *
 * Arc's Memo contract (0x5294E9927c3306DcBaDb03fe70b92e01cCede505) lets you
 * attach indexed memoId + arbitrary memoData to any contract call without
 * touching the target contract. It uses the `CallFrom` precompile so the
 * inner contract still sees the EOA as `msg.sender` — every existing auth
 * check (NotClient, Unauthorized, etc.) keeps working.
 *
 * Design:
 *   - memoId is a bytes32 keccak256 of a short stable label like "bard.job.fund".
 *     Indexed, so a single `eth_getLogs` topic filter pulls every event of that kind.
 *   - memoData is JSON-encoded UTF-8 bytes. Easy to read in explorers, easy to
 *     parse off-chain, schema-flexible. Calldata cost is fine because the bytes
 *     are emitted as event data, not stored.
 *   - The decorator `withMemo(builder, ctx)` takes any existing
 *     {to, data} calldata builder result and returns a new wrapped {to, data}
 *     that the caller submits via the same Turnkey path.
 *
 * Docs:
 *   https://docs.arc.io/arc/concepts/transaction-memos
 *   https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo
 */

import { encodeFunctionData, keccak256, toBytes, toHex } from 'viem';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

export const ARC_MEMO_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';

export const ARC_MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'BeforeMemo',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'target', type: 'address' },
      { indexed: true, name: 'memoId', type: 'bytes32' },
      { indexed: false, name: 'memoIndex', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'target', type: 'address' },
      { indexed: true, name: 'memoId', type: 'bytes32' },
      { indexed: false, name: 'callDataHash', type: 'bytes32' },
      { indexed: false, name: 'memo', type: 'bytes' },
      { indexed: false, name: 'memoIndex', type: 'uint256' },
    ],
  },
];

// ──────────────────────────────────────────────
//  Memo ID registry
//  Stable keccak256-hashed labels for every BARD action that touches chain.
//  Add new entries here when wiring memos for a new lifecycle step — don't
//  rename existing ones (the hash is the wire identifier).
// ──────────────────────────────────────────────

const _label = (s) => keccak256(toBytes(s));

export const MemoIds = Object.freeze({
  // ── Escrow (ERC-8183 + BardJobHook) ──
  JobCreate:    _label('bard.job.create'),
  JobAssign:    _label('bard.job.assign'),
  JobBudget:    _label('bard.job.budget'),
  JobFund:      _label('bard.job.fund'),
  JobSubmit:    _label('bard.job.submit'),
  JobComplete:  _label('bard.job.complete'),
  JobReject:    _label('bard.job.reject'),
  JobRefundExp: _label('bard.job.refund.expired'),
  FeeConfigure: _label('bard.fee.configure'),
  FeeDeposit:   _label('bard.fee.deposit'),
  FeeRefund:    _label('bard.fee.refund'),

  // ── Identity & reputation ──
  ProfileCreate: _label('bard.profile.create'),
  ProfileUpdate: _label('bard.profile.update'),
  PfpMint:       _label('bard.pfp.mint'),
  PfpUpdate:     _label('bard.pfp.update'),
  IdentityMint:  _label('bard.identity.mint'),    // ERC-8004 identity registry

  // ── Vouching ──
  VouchCast:    _label('bard.vouch.cast'),
  VouchUnstake: _label('bard.vouch.unstake'),

  // ── Direct USDC payouts (legacy Turnkey path) ──
  PayoutAgent:   _label('bard.payout.agent'),
  PayoutSwarm:   _label('bard.payout.swarm'),
  PayoutFee:     _label('bard.payout.fee'),
  PayoutRefund:  _label('bard.payout.refund'),
});

// ──────────────────────────────────────────────
//  Encoding helpers
// ──────────────────────────────────────────────

/// JSON-encode an arbitrary object as bytes for the `memoData` field.
/// Use snake_case or camelCase consistently; explorers preserve whatever you ship.
export function encodeMemoData(obj) {
  if (obj == null) return '0x';
  if (typeof obj === 'string') return toHex(toBytes(obj));
  return toHex(toBytes(JSON.stringify(obj)));
}

/// Decode `memoData` bytes back into the original JSON object.
/// Returns the raw decoded string if parsing fails.
export function decodeMemoData(hex) {
  if (!hex || hex === '0x') return null;
  const raw = Buffer.from(hex.slice(2), 'hex').toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ──────────────────────────────────────────────
//  Wrapping
// ──────────────────────────────────────────────

/**
 * Wrap an inner calldata builder result with an Arc memo.
 *
 *   const inner = buildFundCalldata({ jobId: 7n, expectedBudget: 100n * 10n ** 6n });
 *   const wrapped = withMemo(inner, {
 *     memoId: MemoIds.JobFund,
 *     memoData: { bountyId: 'b_abc123', amountUsd: 100 },
 *   });
 *   // Submit `wrapped` via Turnkey instead of `inner`.
 *
 * The wrapped tx targets ARC_MEMO_ADDRESS; the inner target sees the EOA as
 * msg.sender thanks to Arc's CallFrom precompile.
 *
 * @param {{to: `0x${string}`, data: `0x${string}`}} inner
 * @param {{memoId: `0x${string}`, memoData?: unknown}} ctx
 * @returns {{to: `0x${string}`, data: `0x${string}`, memoId: `0x${string}`, memoData: `0x${string}`, innerTo: `0x${string}`, innerData: `0x${string}`}}
 */
export function withMemo(inner, { memoId, memoData }) {
  if (!inner || !inner.to || !inner.data) {
    throw new Error('withMemo: inner must be { to, data }');
  }
  if (!memoId || !/^0x[0-9a-fA-F]{64}$/.test(memoId)) {
    throw new Error('withMemo: memoId must be 0x-prefixed 32-byte hex (use MemoIds.*)');
  }

  const memoDataHex = encodeMemoData(memoData);

  const data = encodeFunctionData({
    abi: ARC_MEMO_ABI,
    functionName: 'memo',
    args: [inner.to, inner.data, memoId, memoDataHex],
  });

  return {
    to: ARC_MEMO_ADDRESS,
    data,
    memoId,
    memoData: memoDataHex,
    innerTo: inner.to,
    innerData: inner.data,
  };
}

// ──────────────────────────────────────────────
//  Log parsing — for the indexer / reconciliation worker
// ──────────────────────────────────────────────

/**
 * Topic filter for `eth_getLogs` that returns every BARD memo of a given kind.
 *
 *   const filter = memoLogFilter(MemoIds.JobFund);
 *   await client.getLogs({ address: ARC_MEMO_ADDRESS, ...filter });
 */
export function memoLogFilter(memoId) {
  // Memo event signature: Memo(address,address,bytes32,bytes32,bytes,uint256)
  const memoEventTopic = keccak256(
    toBytes('Memo(address,address,bytes32,bytes32,bytes,uint256)'),
  );
  return {
    topics: [memoEventTopic, null, null, memoId],
  };
}
