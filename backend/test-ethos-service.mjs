import assert from 'node:assert/strict';
import { clearOwnerAssuranceCache, getOwnerAssurance } from './ethos-service.js';

const address = '0x1111111111111111111111111111111111111111';

function mockEthos({ verificationStatus = null, score = 1540, level = 'reputable' } = {}) {
  return async (url) => {
    if (url.includes('/user/by/address/')) {
      return new Response(JSON.stringify({
        displayName: 'Owner',
        score,
        humanVerificationStatus: verificationStatus,
        links: { profile: 'https://app.ethos.network/profile/owner' },
        stats: {
          review: { received: { positive: 6, neutral: 1, negative: 0 } },
          vouch: { received: { count: 4 } },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ score, level }), { status: 200 });
  };
}

clearOwnerAssuranceCache();
const scoredOnly = await getOwnerAssurance(address, {
  fetchImpl: mockEthos({ verificationStatus: null }),
  force: true,
});
assert.equal(scoredOnly.score, 1540);
assert.equal(scoredOnly.humanVerified, false, 'an Ethos score must not imply human verification');
assert.equal(scoredOnly.relationship, 'owner_linked');

const verified = await getOwnerAssurance(address, {
  fetchImpl: mockEthos({ verificationStatus: 'VERIFIED' }),
  force: true,
});
assert.equal(verified.humanVerified, true);
assert.equal(verified.relationship, 'verified_owner');
assert.deepEqual(verified.reviews, { positive: 6, neutral: 1, negative: 0 });
assert.equal(verified.vouchesReceived, 4);

let requested = false;
const independent = await getOwnerAssurance('0x0000000000000000000000000000000000000000', {
  fetchImpl: async () => { requested = true; throw new Error('must not fetch'); },
});
assert.equal(independent.available, false);
assert.equal(independent.relationship, 'independent');
assert.equal(requested, false);

console.log('Ethos owner assurance tests passed');
