#!/usr/bin/env node

import assert from 'node:assert/strict';
import { computeReputationScore } from './reputation-score.js';

assert.equal(
  computeReputationScore({ completedBounties: 1 }),
  15,
  'a released bounty should contribute +15 reputation',
);

assert.equal(
  computeReputationScore({
    verified: 1,
    pending: 1,
    rejected: 1,
    totalEndorsements: 2,
    completedBounties: 1,
    rejectedBounties: 1,
    verificationApprovals: 2,
    timeDecay: 1,
  }),
  21,
  'all reputation sources and penalties should compose deterministically',
);

assert.equal(
  computeReputationScore({ completedBounties: 10 }),
  100,
  'reputation should cap at 100',
);

assert.equal(
  computeReputationScore({ rejectedBounties: 2, rejected: 3 }),
  0,
  'reputation should not fall below zero',
);

console.log('reputation-score: 4/4 passed');
