import assert from 'node:assert/strict';
import { createHumanEthosHandler } from './human-ethos-route.js';

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
let requestedWallet = null;
const assurance = {
  source: 'ethos',
  available: true,
  ownerWallet: wallet,
  humanVerificationStatus: 'VERIFIED',
  humanVerified: true,
  score: 1540,
  level: 'reputable',
};
const handler = createHumanEthosHandler({
  getAssurance: async (value) => {
    requestedWallet = value;
    return assurance;
  },
});
const response = responseRecorder();
await handler({ human: { wallet_address: wallet } }, response);
assert.equal(requestedWallet, wallet, 'the authenticated BARD wallet must drive the lookup');
assert.equal(response.statusCode, 200);
assert.equal(response.headers['Cache-Control'], 'private, max-age=60');
assert.deepEqual(response.body, { ownerAssurance: assurance });

const unavailable = { source: 'ethos', available: false, ownerWallet: wallet };
const failingHandler = createHumanEthosHandler({
  getAssurance: async () => { throw new Error('Ethos timeout'); },
  getUnavailable: (value) => ({ ...unavailable, ownerWallet: value }),
});
const failedResponse = responseRecorder();
await failingHandler({ human: { wallet_address: wallet } }, failedResponse);
assert.equal(failedResponse.statusCode, 502);
assert.deepEqual(failedResponse.body.ownerAssurance, unavailable);

console.log('Human Ethos route tests passed');
