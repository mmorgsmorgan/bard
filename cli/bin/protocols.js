import { isAddress, verifyTypedData, hashTypedData, keccak256, toBytes, zeroAddress } from 'viem';
import { hashTaskSpec, canonicalJson, buildJobProposalDomain, JOB_PROPOSAL_TYPES } from './agreement-format.js';

export async function aclProposal(input, verify = false) {
  const { task, proposal, contract } = input;
  if (!isAddress(contract) || contract === zeroAddress) throw new Error('Missing Arc escrow contract.');
  const taskSpecHash = hashTaskSpec(task);
  if (proposal.taskSpecHash && proposal.taskSpecHash !== taskSpecHash) throw new Error('Task hash mismatch.');
  if (BigInt(proposal.amount) <= 0n || BigInt(proposal.expiresAt) <= BigInt(Math.floor(Date.now()/1000))) throw new Error('Invalid amount or expired offer.');
  const typed = { domain: buildJobProposalDomain({ chainId: 5042002, agenticCommerce: contract }),
    types: JOB_PROPOSAL_TYPES, primaryType: 'JobProposal', message: { ...proposal, taskSpecHash } };
  const digest = hashTypedData(typed);
  if (verify) {
    for (const role of ['client','provider']) {
      if (!await verifyTypedData({ ...typed, address: proposal[role], signature: input[role + 'Signature'] })) throw new Error('Invalid ' + role + ' signature.');
    }
  }
  return { typed, digest };
}

export async function aclDelivery(input) {
  const { digest } = await aclProposal(input, true);
  const { delivery, signature } = input;
  const { verifyMessage } = await import('viem');
  const message = canonicalJson({ proposalDigest: digest, delivery });
  if (!await verifyMessage({ address: input.proposal.provider, message, signature })) throw new Error('Invalid delivery signature.');
  return { proposalDigest: digest, deliveryHash: keccak256(toBytes(message)), verifiedProvider: input.proposal.provider };
}

export async function checkVcr({ ensName, recipient, amount }, base = process.env.BARD_VCR_URL, fetchImpl = fetch) {
  if (!base || !ensName || !isAddress(recipient) || !/^[1-9][0-9]*$/.test(String(amount))) throw new Error('Set BARD_VCR_URL and supply ensName, recipient and positive USDC base units.');
  const spendRequest = { recipient, amount: String(amount), token: 'USDC', chain: 'arc-testnet' };
  const response = await fetchImpl(new URL('/api/verify', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ensName, spendRequest }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('VCR verifier unavailable: HTTP ' + response.status);
  const { result } = await response.json();
  if (result?.allowed !== true) throw new Error(result?.reason || 'VCR denied payment.');
  return { allowed: true, spendRequest, policyCid: result.policyCid };
}
