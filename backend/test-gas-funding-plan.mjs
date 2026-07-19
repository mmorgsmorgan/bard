#!/usr/bin/env node

import assert from 'node:assert/strict';
import { calculateGasFundingPlan } from './escrow-service.js';

const profilePlan = calculateGasFundingPlan({
  balance: 5_000_000_000_000_000n,
  estimatedGas: 543_326n,
  gasPrice: 25_000_000_000n,
});

assert.equal(profilePlan.gasLimit, 651_992n);
assert.equal(profilePlan.bufferedGasPrice, 31_250_000_000n);
assert.equal(profilePlan.requiredBalance, 22_374_750_000_000_000n);
assert.equal(profilePlan.topUpWei, 17_374_750_000_000_000n);

const fundedPlan = calculateGasFundingPlan({
  balance: profilePlan.requiredBalance,
  estimatedGas: 543_326n,
  gasPrice: 25_000_000_000n,
});
assert.equal(fundedPlan.topUpWei, 0n);

const valuePlan = calculateGasFundingPlan({
  balance: 0n,
  estimatedGas: 21_000n,
  gasPrice: 10n,
  value: 100n,
  gasLimitBufferBps: 10_000n,
  gasPriceBufferBps: 10_000n,
  reserveWei: 0n,
});
assert.equal(valuePlan.requiredBalance, 210_100n);
assert.equal(valuePlan.topUpWei, 210_100n);

console.log('gas-funding-plan: 7/7 passed');
