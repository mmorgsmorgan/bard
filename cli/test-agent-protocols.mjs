import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { aclProposal, aclDelivery, checkVcr } from './bin/protocols.js';
import { canonicalJson } from './bin/agreement-format.js';

const client = privateKeyToAccount('0x' + '11'.repeat(32));
const provider = privateKeyToAccount('0x' + '22'.repeat(32));
const input = { contract: client.address, task: { title: 'Inspect', objective: 'Inspect a patch', acceptanceCriteria: ['Report defects'], requiredFormat: 'markdown', deliveryType: 'text/markdown', taskDomain: 'code', createdAt: '2026-01-01' },
  proposal: { client: client.address, provider: provider.address, evaluator: client.address, paymentToken: provider.address, hook: client.address, amount: '1000000', expiresAt: '4102444800', nonce: '0x' + '33'.repeat(32) } };
const { typed, digest } = await aclProposal(input);
input.clientSignature = await client.signTypedData(typed);
input.providerSignature = await provider.signTypedData(typed);
assert.equal((await aclProposal(input, true)).digest, digest);
input.delivery = { content: 'Found a bug' };
input.signature = await provider.signMessage({ message: canonicalJson({ proposalDigest: digest, delivery: input.delivery }) });
assert.equal((await aclDelivery(input)).verifiedProvider, provider.address);
await assert.rejects(aclDelivery({ ...input, delivery: { content: 'Changed' } }));
await assert.rejects(aclProposal({ ...input, task: { ...input.task, objective: 'Changed' } }, true));
const spend = { ensName: 'agent.eth', recipient: client.address, amount: '1000000' };
assert.equal((await checkVcr(spend, 'https://example.invalid', async (url, opts) => {
  assert.equal(url.pathname, '/api/verify');
  assert.equal(JSON.parse(opts.body).spendRequest.chain, 'arc-testnet');
  return Response.json({ result: { allowed: true } });
})).allowed, true);
await assert.rejects(checkVcr(spend, 'https://example.invalid', async () => Response.json({ result: { allowed: false, reason: 'cap' } })), /cap/);
console.log('ACL dual signatures, altered terms, altered delivery, VCR allow and deny passed.');
