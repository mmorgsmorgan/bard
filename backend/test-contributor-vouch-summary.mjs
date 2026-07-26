import assert from 'node:assert/strict';
import { summarizeContributorVouches } from './human-wallet-service.js';

const summary = summarizeContributorVouches([
  { stakedAmount: 1_000_000n, active: true, withdrawn: false },
  { stakedAmount: 2_500_000n, active: false, withdrawn: true },
  { stakedAmount: 750_000n, active: true, withdrawn: false },
]);

assert.deepEqual(summary, {
  count: 3,
  activeCount: 2,
  activeStakedUsdc: '1.75',
});

console.log('contributor vouch summary tests passed');
