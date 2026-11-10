import { hashTypedData, verifyMessage, verifyTypedData, parseUnits, keccak256, toBytes, zeroAddress } from 'viem';
import { buildJobProposalDomain, JOB_PROPOSAL_TYPES, hashTaskSpec, canonicalJson } from './agreement-format.js';
import { AGENTIC_COMMERCE_ADDRESS, BARD_JOB_HOOK_ADDRESS, USDC_ADDRESS } from './erc8183-client.js';

function platformFeeTerms(amount, bid) {
  const stored = bid.acl_offer?.task?.extensions?.platformFee;
  if (bid.acl_offer && !stored) throw new Error('Signed ACL platform fee terms are missing. Submit a new proposal.');

  // Existing offers keep their signed fee even after the operator changes the
  // rate. Only a new or revised proposal picks up the current configuration.
  const rate = stored ? stored.bps : process.env.PLATFORM_FEE_BPS || '0';
  if (!/^(0|[1-9][0-9]*)$/.test(String(rate)) || Number(rate) > 10_000) {
    throw new Error('Platform fee must be an integer from 0 to 10000 basis points.');
  }
  const bps = Number(rate);
  const recipient = stored ? stored.recipient : process.env.SELLER_ADDRESS?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient || '') || recipient === zeroAddress) {
    throw new Error('Invalid platform fee recipient.');
  }
  const fee = { bps, amount: (amount * BigInt(bps) / 10_000n).toString(), recipient };
  if (stored && canonicalJson(stored) !== canonicalJson(fee)) {
    throw new Error('Signed ACL platform fee terms are inconsistent.');
  }
  return fee;
}

export function jobTerms(bounty, bid, provider) {
  const amount = parseUnits(String(bid.proposed_price_usdc), 6);
  const criteria = typeof bounty.acceptance_criteria === 'string' ? JSON.parse(bounty.acceptance_criteria) : bounty.acceptance_criteria;
  const task = { title: bounty.title, objective: bounty.description || bounty.title,
    acceptanceCriteria: (criteria || []).map(c => typeof c === 'string' ? c : c.text),
    requiredFormat: 'Bard evidence package', deliveryType: 'application/json', taskDomain: bounty.category || 'general',
    createdAt: String(bounty.created_at), extensions: { bountyId: bounty.id, proposalId: bid.id, plan: bid.plan, estimatedHours: Number(bid.estimated_hours || 0), platformFee: platformFeeTerms(amount, bid) } };
  const domain = buildJobProposalDomain({ chainId: 5042002, agenticCommerce: AGENTIC_COMMERCE_ADDRESS });
  if (domain.verifyingContract === zeroAddress || !process.env.SELLER_ADDRESS) throw new Error('Missing fresh Arc escrow or evaluator address.');
  const message = { client: bounty.creator_wallet, provider, evaluator: process.env.SELLER_ADDRESS,
    paymentToken: USDC_ADDRESS, amount: amount.toString(), hook: BARD_JOB_HOOK_ADDRESS,
    taskSpecHash: hashTaskSpec(task), expiresAt: String(Math.floor(Date.parse(bounty.deadline)/1000)), nonce: keccak256(toBytes(bid.id)) };
  return { task, domain, message };
}
export function typedAgreement(terms) {
  return { domain: terms.domain, types: JOB_PROPOSAL_TYPES, primaryType: 'JobProposal', message: terms.message };
}
export async function verifyAgreement(terms, offer, accepted = false) {
  if (!offer || canonicalJson(offer.message) !== canonicalJson(terms.message) || canonicalJson(offer.domain) !== canonicalJson(terms.domain) ||
      hashTaskSpec(offer.task) !== terms.message.taskSpecHash) throw new Error('Signed ACL terms differ from the Bard job.');
  for (const role of accepted ? ['provider','client'] : ['provider']) {
    if (!await verifyTypedData({ ...typedAgreement(terms), address: terms.message[role], signature: offer[role + 'Signature'] })) throw new Error('Invalid ACL ' + role + ' signature.');
  }
}

export async function attestDelivery(terms, offer, packageHash, signer) {
  await verifyAgreement(terms, offer, true);
  const proposalDigest = hashTypedData(typedAgreement(terms));
  const delivery = { packageHash };
  const message = canonicalJson({ proposalDigest, delivery });
  const signature = await signer.signMessage({ message });
  if (!await verifyMessage({ address: terms.message.provider, message, signature })) throw new Error('Delivery signer does not match the agreed provider.');
  return { proposalDigest, delivery, signature, deliveryHash: keccak256(toBytes(message)) };
}

export async function verifyDelivery(terms, offer, proof, packageHash) {
  await verifyAgreement(terms, offer, true);
  const proposalDigest = hashTypedData(typedAgreement(terms));
  if (!proof || proof.proposalDigest !== proposalDigest || proof.delivery?.packageHash !== packageHash) throw new Error('Stored delivery differs from its attestation.');
  const message = canonicalJson({ proposalDigest, delivery: { packageHash } });
  if (proof.deliveryHash !== keccak256(toBytes(message)) ||
      !await verifyMessage({ address: terms.message.provider, message, signature: proof.signature })) throw new Error('Invalid provider delivery attestation.');
}
