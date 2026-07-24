import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOUCH_TIER_MIN_USDC,
  buildHumanVouchTransactions,
  validateVouchInput,
} from './human-wallet-service.js';
import { resolveVouchTarget } from './vouch-target.js';

const CONTRIBUTOR = '0x1111111111111111111111111111111111111111';
const VOUCHER = '0x2222222222222222222222222222222222222222';

test('all four vouch tiers accept their exact minimum', () => {
  VOUCH_TIER_MIN_USDC.forEach((amount, tier) => {
    const transactions = buildHumanVouchTransactions({
      contributorWallet: CONTRIBUTOR,
      amount: String(amount),
      tier,
      statement: 'Verified work',
      ecosystem: 'Arc',
      score: 80,
    }, { voucherAddress: VOUCHER });

    assert.equal(transactions.stakeAmount, BigInt(amount) * 1_000_000n);
    assert.match(transactions.approve.data, /^0x[0-9a-f]+$/);
    assert.match(transactions.vouch.data, /^0x[0-9a-f]+$/);
  });
});

test('vouch validation rejects below-minimum amounts and malformed values', () => {
  assert.throws(() => validateVouchInput({
    contributorWallet: CONTRIBUTOR,
    amount: '9.999999',
    tier: 1,
    statement: 'Verified work',
    ecosystem: 'Arc',
  }), /at least 10 USDC/);

  assert.throws(() => validateVouchInput({
    contributorWallet: CONTRIBUTOR,
    amount: '1.0000001',
    tier: 0,
    statement: 'Verified work',
    ecosystem: 'Arc',
  }), /at most 6 decimals/);
});

test('vouch validation rejects invalid tier, score, address, and self-vouch', () => {
  const valid = {
    contributorWallet: CONTRIBUTOR,
    amount: '1',
    tier: 0,
    statement: 'Verified work',
    ecosystem: 'Arc',
    score: 80,
  };

  assert.throws(() => validateVouchInput({ ...valid, tier: 4 }), /between 0 and 3/);
  assert.throws(() => validateVouchInput({ ...valid, score: 80.5 }), /integer between 0 and 100/);
  assert.throws(() => validateVouchInput({ ...valid, contributorWallet: '0xbad' }), /Valid contributor/);
  assert.throws(
    () => validateVouchInput(valid, { voucherAddress: CONTRIBUTOR.toUpperCase().replace('0X', '0x') }),
    /cannot vouch for yourself/
  );
});

test('vouch validation requires a statement and ecosystem', () => {
  const valid = {
    contributorWallet: CONTRIBUTOR,
    amount: '1',
    tier: 0,
    statement: 'Verified work',
    ecosystem: 'Arc',
  };

  assert.throws(() => validateVouchInput({ ...valid, statement: ' ' }), /statement required/);
  assert.throws(() => validateVouchInput({ ...valid, ecosystem: '' }), /ecosystem required/);
});

test('vouch targets resolve wallets, human usernames, agent IDs, and agent names', async () => {
  const targetAgent = {
    id: 'agent-target',
    agent_name: 'Target Agent',
    turnkey_address: '0x3333333333333333333333333333333333333333',
    owner_wallet: '0x4444444444444444444444444444444444444444',
  };
  const mockStmts = {
    getProfileByUsername: async (username) => username === 'alice'
      ? { wallet: CONTRIBUTOR }
      : null,
    getAgentById: async (id) => id === targetAgent.id ? targetAgent : null,
    getAgentByName: async (name) => name.toLowerCase() === targetAgent.agent_name.toLowerCase()
      ? targetAgent
      : null,
  };

  assert.deepEqual(
    await resolveVouchTarget(mockStmts, { contributorWallet: CONTRIBUTOR }),
    { contributorWallet: CONTRIBUTOR, contributorAgentId: null }
  );
  assert.deepEqual(
    await resolveVouchTarget(mockStmts, { contributorUsername: 'alice' }),
    { contributorWallet: CONTRIBUTOR, contributorAgentId: null }
  );
  assert.deepEqual(
    await resolveVouchTarget(mockStmts, { contributorAgentId: 'agent-target' }),
    {
      contributorWallet: targetAgent.turnkey_address,
      contributorAgentId: targetAgent.id,
    }
  );
  assert.deepEqual(
    await resolveVouchTarget(mockStmts, { contributorAgentName: 'target agent' }),
    {
      contributorWallet: targetAgent.turnkey_address,
      contributorAgentId: targetAgent.id,
    }
  );
});

test('vouch target resolution requires exactly one target', async () => {
  const mockStmts = {};
  await assert.rejects(() => resolveVouchTarget(mockStmts, {}), /exactly one vouch target/);
  await assert.rejects(() => resolveVouchTarget(mockStmts, {
    contributorWallet: CONTRIBUTOR,
    contributorUsername: 'alice',
  }), /exactly one vouch target/);
});
