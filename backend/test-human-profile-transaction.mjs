#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  buildHumanProfileMetadataURI,
  buildHumanProfileTransactions,
  validateExternalTransactionDetails,
} from './human-wallet-service.js';

const wallet = '0xa1a16e5ee45a999845ef6c7cf99b16666b2ba3c8';
const profile = {
  username: 'profile-calldata-test',
  displayName: 'Profile Calldata Test',
  profileType: 'human',
  bio: 'Deterministic profile metadata',
  ecosystems: ['Arc'],
  wallet,
  farcaster: '',
  github: 'mmorgsmorgan',
  x: '',
  discord: '',
  linkedin: '',
  pfp: 'https://example.com/pfp-v1.png',
};

const firstMetadataURI = buildHumanProfileMetadataURI(profile);
await new Promise((resolve) => setTimeout(resolve, 10));
const secondMetadataURI = buildHumanProfileMetadataURI(profile);
assert.equal(firstMetadataURI, secondMetadataURI);

const metadata = JSON.parse(
  decodeURIComponent(firstMetadataURI.slice(firstMetadataURI.indexOf(',') + 1))
);
assert.equal(metadata.pfp, profile.pfp);
assert.equal(metadata.created_at, undefined);

const firstTransactions = buildHumanProfileTransactions({
  username: profile.username,
  metadataURI: firstMetadataURI,
  profileType: 0,
});
const secondTransactions = buildHumanProfileTransactions({
  username: profile.username,
  metadataURI: secondMetadataURI,
  profileType: 0,
});
assert.equal(firstTransactions.create.data, secondTransactions.create.data);
assert.equal(firstTransactions.update.data, secondTransactions.update.data);

const changedPfpURI = buildHumanProfileMetadataURI({
  ...profile,
  pfp: 'https://example.com/pfp-v2.png',
});
const changedTransactions = buildHumanProfileTransactions({
  username: profile.username,
  metadataURI: changedPfpURI,
  profileType: 0,
});
assert.notEqual(firstTransactions.update.data, changedTransactions.update.data);

const verification = validateExternalTransactionDetails({
  receipt: { status: 'success' },
  transaction: {
    from: wallet,
    to: changedTransactions.update.to,
    input: changedTransactions.update.data,
    value: 0n,
  },
  expectedFrom: wallet,
  expectedTo: changedTransactions.update.to,
  acceptedData: [
    changedTransactions.create.data,
    changedTransactions.update.data,
  ],
});
assert.equal(verification.valid, true);

console.log('Human profile transaction tests passed');
