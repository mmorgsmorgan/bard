#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  arcRpcRetryDelay,
  arcTxPaceDelay,
  isTransientArcRpcError,
  withArcRpcRetry,
} from './escrow-service.js';

const nestedRateLimit = new Error('RPC Request failed');
nestedRateLimit.cause = { code: -32011, message: 'request limit reached' };
assert.equal(isTransientArcRpcError(nestedRateLimit), true);
assert.equal(isTransientArcRpcError(new Error('execution reverted')), false);
assert.equal(arcRpcRetryDelay(1), 500);
assert.equal(arcRpcRetryDelay(6), 8_000);
assert.equal(arcTxPaceDelay(1_000, 2_500, 2_000), 500);
assert.equal(arcTxPaceDelay(1_000, 3_000, 2_000), 0);

let attempts = 0;
const delays = [];
const result = await withArcRpcRetry(() => {
  attempts += 1;
  if (attempts < 3) throw nestedRateLimit;
  return 'confirmed';
}, {
  label: 'test receipt',
  attempts: 4,
  baseDelayMs: 1,
  sleepFn: async (delay) => delays.push(delay),
});

assert.equal(result, 'confirmed');
assert.equal(attempts, 3);
assert.deepEqual(delays, [1, 2]);

let nonTransientAttempts = 0;
await assert.rejects(
  withArcRpcRetry(() => {
    nonTransientAttempts += 1;
    throw new Error('execution reverted');
  }, {
    attempts: 4,
    sleepFn: async () => {},
  }),
  /execution reverted/,
);
assert.equal(nonTransientAttempts, 1);

console.log('arc-rpc-retry: 10/10 passed');
