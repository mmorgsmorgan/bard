import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { canonicalJson } from './agreement-format.js';

const client = privateKeyToAccount('0x' + '11'.repeat(32));
const provider = privateKeyToAccount('0x' + '22'.repeat(32));
process.env.AGENTIC_COMMERCE_ADDRESS = '0x' + '33'.repeat(20);
process.env.SELLER_ADDRESS = '0x' + '44'.repeat(20);
process.env.PLATFORM_FEE_BPS = '500';
const { jobTerms, verifyAgreement, typedAgreement, attestDelivery, verifyDelivery } = await import('./agent-agreement.js');
const bounty = { id: 'b1', title: 'Review', description: 'Review patch', creator_wallet: client.address, created_at: '2026-01-01', deadline: '2099-01-01', acceptance_criteria: [{ text: 'Explain one defect' }] };
const bid = { id: 'p1', plan: 'Review diff', proposed_price_usdc: '1.25' };
const terms = jobTerms(bounty, bid, provider.address);
const typed = typedAgreement(terms);
const offer = { ...terms, providerSignature: await provider.signTypedData(typed), clientSignature: await client.signTypedData(typed) };
await verifyAgreement(terms, offer, true);
assert.deepEqual(terms.task.extensions.platformFee, { bps: 500, amount: '62500', recipient: process.env.SELLER_ADDRESS });
// Existing offers retain their signed fee; new offers use the new rate.
process.env.PLATFORM_FEE_BPS = '1000';
const storedBid = { ...bid, acl_offer: offer };
await verifyAgreement(jobTerms(bounty, storedBid, provider.address), offer, true);
assert.equal(jobTerms(bounty, bid, provider.address).task.extensions.platformFee.amount, '125000');
for (const patch of [{ bps: 1000, amount: '125000' }, { recipient: client.address.toLowerCase() }]) {
  const changed = structuredClone(offer);
  Object.assign(changed.task.extensions.platformFee, patch);
  const changedTerms = jobTerms(bounty, { ...bid, acl_offer: changed }, provider.address);
  // Rebuilding both the message and hash still cannot forge the old signatures.
  await assert.rejects(verifyAgreement(changedTerms, { ...changed, ...changedTerms }, true), /signature/);
}
const inconsistent = structuredClone(offer);
inconsistent.task.extensions.platformFee.amount = '1';
assert.throws(() => jobTerms(bounty, { ...bid, acl_offer: inconsistent }, provider.address), /inconsistent/);
const missingFee = structuredClone(offer);
delete missingFee.task.extensions.platformFee;
assert.throws(() => jobTerms(bounty, { ...bid, acl_offer: missingFee }, provider.address), /missing/);
process.env.PLATFORM_FEE_BPS = '333';
assert.equal(jobTerms(bounty, { ...bid, proposed_price_usdc: '1.000001' }, provider.address).task.extensions.platformFee.amount, '33300');
process.env.PLATFORM_FEE_BPS = '0';
assert.equal(jobTerms(bounty, bid, provider.address).task.extensions.platformFee.amount, '0');
for (const invalid of ['-1', '10001', '1.5', 'invalid', '500bps']) {
  process.env.PLATFORM_FEE_BPS = invalid;
  assert.throws(() => jobTerms(bounty, bid, provider.address), /basis points/);
}
process.env.PLATFORM_FEE_BPS = '500';
await assert.rejects(verifyAgreement(jobTerms(bounty, { ...bid, proposed_price_usdc: '2' }, provider.address), offer, true));
await assert.rejects(verifyAgreement(jobTerms({ ...bounty, id: 'b2' }, bid, provider.address), offer, true));
await assert.rejects(verifyAgreement(terms, { ...offer, clientSignature: offer.providerSignature }, true));
const proof = await attestDelivery(terms, offer, '0x' + '55'.repeat(32), provider);
assert.equal(await verifyMessage({ address: provider.address, message: canonicalJson({ proposalDigest: proof.proposalDigest, delivery: proof.delivery }), signature: proof.signature }), true);
await assert.rejects(attestDelivery(terms, offer, '0x' + '55'.repeat(32), client));
await verifyDelivery(terms, offer, proof, proof.delivery.packageHash);
await assert.rejects(verifyDelivery(terms, offer, proof, '0x' + '66'.repeat(32)), /differs/);
await assert.rejects(verifyDelivery(terms, offer, { ...proof, signature: offer.clientSignature }, proof.delivery.packageHash), /attestation/);
console.log('Arc agreements, immutable fees, fee validation, signatures and delivery tampering checks passed.');
