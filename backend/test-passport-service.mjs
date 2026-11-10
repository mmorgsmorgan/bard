import assert from 'node:assert/strict';
import { getPassportAssurance, passportConfigured } from './passport-service.js';

const address = '0x1111111111111111111111111111111111111111';
const now = Date.parse('2026-11-09T12:00:00Z');
const env = { PASSPORT_API_KEY: 'test-only', PASSPORT_SCORER_ID: '123' };
const valid = {
  address, score: '30.5', threshold: '20', passing_score: true, error: null,
  last_score_timestamp: '2026-11-09T11:00:00Z', expiration_timestamp: '2026-12-01T11:00:00Z',
  stamps: { privateFixture: { credential: 'must-never-be-returned' } },
};
const check = (data, options = {}) => getPassportAssurance(address, {
  env, now, fetchImpl: async (url, init) => {
    assert.equal(url, `https://api.passport.xyz/v2/stamps/123/score/${address}`);
    assert.equal(init.headers['X-API-KEY'], 'test-only');
    assert.equal(init.redirect, 'error');
    return Response.json(data);
  }, ...options,
});
assert.equal(passportConfigured(env), true);
assert.equal(passportConfigured({ PASSPORT_API_KEY: 'key' }), false);
const proof = await check(valid);
assert.equal(proof.passed, true);
assert.equal(proof.score, 30.5);
assert.equal(proof.scorerId, '123');
assert.equal(JSON.stringify(proof).includes('privateFixture'), false);
assert.equal(JSON.stringify(proof).includes('test-only'), false);

for (const [name, changed] of Object.entries({
  rejected: { passing_score: false },
  belowThreshold: { score: '19' },
  expired: { expiration_timestamp: '2026-11-09T11:30:00Z' },
  wrongWallet: { address: '0x2222222222222222222222222222222222222222' },
  emptyScore: { score: '' },
  infiniteScore: { score: 'Infinity' },
  negativeScore: { score: '-1' },
  invalidThreshold: { threshold: '0' },
  stringBoolean: { passing_score: 'true' },
  missingExpiry: { expiration_timestamp: undefined },
  backwardsTime: { expiration_timestamp: '2026-11-09T10:00:00Z' },
  futureScore: { last_score_timestamp: '2026-11-10T11:00:00Z' },
  providerError: { error: 'internal provider details' },
})) assert.equal((await check({ ...valid, ...changed })).passed, false, name);

for (const status of [401, 404, 429, 503]) {
  assert.equal((await check(valid, { fetchImpl: async () => Response.json({}, { status }) })).available, false);
}
assert.equal((await check(valid, { fetchImpl: async () => { throw new Error('network'); } })).passed, false);
assert.equal((await check(valid, { env: {}, fetchImpl: () => assert.fail('unconfigured provider must not be called') })).reason, 'passport_not_configured');
assert.equal((await check(valid, { env: { ...env, PASSPORT_API_BASE: 'http://unsafe.example' }, fetchImpl: () => assert.fail('key must not be sent over HTTP') })).reason, 'passport_invalid_config');
console.log('Passport score, threshold, expiry, wallet binding, private data and failure checks passed.');
