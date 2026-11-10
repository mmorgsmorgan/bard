import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashTypedData } from 'viem';
import * as backend from './agreement-format.js';
import * as cli from '../cli/bin/agreement-format.js';

// Fixed outputs captured before replacing the adapted ACL helper implementation.
const task = { title: 'Inspect', objective: 'Inspect a patch', acceptanceCriteria: ['Report defects'], requiredFormat: 'markdown', deliveryType: 'text/markdown', taskDomain: 'code', createdAt: '2026-01-01' };
const taskHash = '0xa97d51546059a809c33b3a9c99eeb59ef8566e9297a26066f3de351b83568c87';
const proposalDigest = '0x9bf5266d5593a1bc86e1ece8772b91350c85a7ae80a9cbc5f27fb4cec205f10c';
const addresses = Array.from({ length: 5 }, (_, i) => '0x' + String(i + 1).repeat(40));

for (const [name, format] of [['backend', backend], ['cli', cli]]) {
  test(`${name}: canonical output preserves ordering, escaping and JSON numbers`, () => {
    assert.equal(format.canonicalJson({ z: 0, a: { '2': 'second', '10': 'tenth', a: 'quote"\n' } }), '{"a":{"10":"tenth","2":"second","a":"quote\\\"\\n"},"z":0}');
    assert.equal(format.canonicalJson({ b: ['é', '🌊', -0, 1e-7], a: {} }), '{"a":{},"b":["é","🌊",0,1e-7]}');
    assert.equal(format.canonicalJson([1, 'a', true, false, null]), '[1,"a",true,false,null]');
    assert.equal(format.canonicalJson(null), 'null');
    const shared = { a: true };
    assert.equal(format.canonicalJson([shared, shared]), '[{"a":true},{"a":true}]');
  });

  test(`${name}: task hash and EIP-712 proposal digest remain compatible`, () => {
    assert.equal(format.hashTaskSpec(task), taskHash);
    assert.equal(format.hashTaskSpec({ ...task, extensions: {}, forbiddenClaims: null, evaluationRubric: null, ignored: true }), taskHash);
    assert.equal(format.hashTaskSpec(Object.fromEntries(Object.entries(task).reverse())), taskHash);
    assert.notEqual(format.hashTaskSpec({ ...task, objective: 'Different work' }), taskHash);
    assert.notEqual(format.hashTaskSpec({ ...task, extensions: { platformFee: { bps: 500 } } }), taskHash);
    assert.equal(hashTypedData({
      domain: format.buildJobProposalDomain({ chainId: 5042002, agenticCommerce: addresses[4] }),
      types: format.JOB_PROPOSAL_TYPES,
      primaryType: 'JobProposal',
      message: { client: addresses[0], provider: addresses[1], evaluator: addresses[2], paymentToken: addresses[3], amount: '1000000', hook: addresses[4], taskSpecHash: taskHash, expiresAt: '4102444800', nonce: '0x' + '33'.repeat(32) },
    }), proposalDigest);
  });

  test(`${name}: invalid signed values fail instead of silently losing data`, () => {
    for (const value of [undefined, 1n, NaN, Infinity, -Infinity, () => {}, Symbol('bad')]) {
      assert.throws(() => format.canonicalJson(value), /JSON/);
      assert.throws(() => format.canonicalJson({ nested: [value] }), /JSON/);
    }
    assert.throws(() => format.canonicalJson(new Array(1)), /JSON/);
    assert.throws(() => format.canonicalJson(new Date()), /JSON/);
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => format.canonicalJson(cycle), /cycles/);
    assert.throws(() => format.hashTaskSpec({ ...task, title: undefined }), /JSON/);
  });
}
