// Bard's ACL-compatible message format. Keep the standalone CLI copy in sync.
import stringify from 'fast-json-stable-stringify';
import { keccak256, toBytes } from 'viem';

function requireJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Signed data must contain only finite JSON values.');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Signed data must use plain JSON objects.');
  }
  if (ancestors.has(value)) throw new TypeError('Signed data cannot contain cycles.');
  ancestors.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) requireJson(entry, ancestors);
  ancestors.delete(value);
}

export function canonicalJson(value) {
  requireJson(value);
  return stringify(value);
}

const taskFields = 'title objective acceptanceCriteria requiredFormat deliveryType taskDomain createdAt'.split(' ');

export function hashTaskSpec(task) {
  const fields = Object.fromEntries(taskFields.map(name => [name, task[name]]));
  for (const name of ['forbiddenClaims', 'evaluationRubric', 'extensions']) {
    fields[name] = task[name] ?? (name === 'extensions' ? {} : null);
  }
  return keccak256(toBytes(canonicalJson(fields)));
}

export function buildJobProposalDomain({ chainId, agenticCommerce }) {
  return { chainId, verifyingContract: agenticCommerce, name: 'ACL JobProposal', version: '1' };
}

// Field order and domain are protocol data: changing either invalidates signatures.
export const JOB_PROPOSAL_TYPES = {
  JobProposal: [
    ['client', 'address'], ['provider', 'address'], ['evaluator', 'address'],
    ['paymentToken', 'address'], ['amount', 'uint256'], ['hook', 'address'],
    ['taskSpecHash', 'bytes32'], ['expiresAt', 'uint64'], ['nonce', 'bytes32'],
  ].map(([name, type]) => ({ name, type })),
};
