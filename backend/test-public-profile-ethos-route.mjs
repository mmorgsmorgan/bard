import assert from 'node:assert/strict';
import { createPublicProfileEthosHandler } from './public-profile-ethos-route.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const wallet = '0x1111111111111111111111111111111111111111';
const assurance = {
  source: 'ethos',
  available: true,
  ownerWallet: wallet,
  humanVerificationStatus: 'VERIFIED',
  humanVerified: true,
  score: 1540,
  level: 'reputable',
};

let requestedWallet = null;
const handler = createPublicProfileEthosHandler({
  getProfile: async (value) => ({ wallet: value.toLowerCase() }),
  getAssurance: async (value) => {
    requestedWallet = value;
    return assurance;
  },
});
const response = responseRecorder();
await handler({ params: { wallet: wallet.toUpperCase() } }, response);
assert.equal(requestedWallet, wallet);
assert.equal(response.statusCode, 200);
assert.equal(response.headers['Cache-Control'], 'public, max-age=60, stale-while-revalidate=300');
assert.deepEqual(response.body, { ownerAssurance: assurance });

const missingResponse = responseRecorder();
await createPublicProfileEthosHandler({
  getProfile: async () => null,
})({ params: { wallet } }, missingResponse);
assert.equal(missingResponse.statusCode, 404);
assert.deepEqual(missingResponse.body, { error: 'Profile not found' });

const unavailable = { source: 'ethos', available: false, ownerWallet: wallet };
const failedResponse = responseRecorder();
await createPublicProfileEthosHandler({
  getProfile: async () => ({ wallet }),
  getAssurance: async () => { throw new Error('Ethos timeout'); },
  getUnavailable: (value) => ({ ...unavailable, ownerWallet: value }),
})({ params: { wallet } }, failedResponse);
assert.equal(failedResponse.statusCode, 502);
assert.deepEqual(failedResponse.body.ownerAssurance, unavailable);

console.log('Public profile Ethos route tests passed');
