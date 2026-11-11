import { policyError, policyHash } from './vcr-policy.js';
import { releaseOperationLock } from './vcr-registry.js';

export const managedSendSchema = `CREATE TABLE IF NOT EXISTS managed_sends (
  operation TEXT PRIMARY KEY, agent_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  request JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'prepared'
    CHECK(status IN ('prepared','dispatching','submitted','confirmed','reverted')),
  tx_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`;

export function sendOperation(agentId, key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) {
    throw policyError('Provide an idempotencyKey (8–100 letters, digits, _ or -); reuse it when retrying this send.', 'idempotency_key_required', 400);
  }
  return 'send:' + policyHash({ agentId,key });
}

export async function executeManagedSend(pool, request, send, { reserve, receipt, lockPool = pool } = {}) {
  const db = await lockPool.connect();
  const key = 'managed-send:' + request.operation;
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
    await db.query(`INSERT INTO managed_sends(operation,agent_id,request_hash,request)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[request.operation,request.agentId,policyHash(request),request]);
    const prior = (await db.query('SELECT * FROM managed_sends WHERE operation=$1',[request.operation])).rows[0];
    if (prior.agent_id !== request.agentId || prior.request_hash !== policyHash(request)) throw policyError('Send retry changed its signed terms.', 'spend_conflict', 409);
    if (prior.status === 'reverted') throw policyError('This send reverted. Use a new idempotencyKey only for an intentional new send.', 'send_reverted', 409);
    if (prior.tx_hash) {
      let status = prior.status;
      if (status === 'submitted' && receipt) {
        const confirmed = await receipt(prior.tx_hash).catch(() => null);
        if (confirmed) {
          status = confirmed.status === 'success' ? 'confirmed' : 'reverted';
          await db.query('UPDATE managed_sends SET status=$2,updated_at=now() WHERE operation=$1',[request.operation,status]);
        }
      }
      if (status === 'reverted') throw policyError('This send reverted on chain.', 'send_reverted', 409);
      return { txHash: prior.tx_hash, pending: status !== 'confirmed', replayed: true };
    }
    if (prior.status !== 'prepared') throw policyError('This send may have been broadcast. Operator reconciliation is required before any new send; keep the same idempotencyKey.', 'send_reconciliation_required', 409);
    if (reserve) await reserve();
    let broadcastHash;
    try {
      const result = await send({
        beforeBroadcast: async () => {
          await db.query("UPDATE managed_sends SET status='dispatching',updated_at=now() WHERE operation=$1",[request.operation]);
        },
        onBroadcast: async txHash => {
          broadcastHash = txHash;
          await db.query("UPDATE managed_sends SET status='submitted',tx_hash=$2,updated_at=now() WHERE operation=$1",[request.operation,txHash]);
        },
      });
      await db.query("UPDATE managed_sends SET status='confirmed',tx_hash=$2,updated_at=now() WHERE operation=$1",[request.operation,result.txHash]);
      return { txHash: result.txHash, pending: false, replayed: false };
    } catch (err) {
      const txHash = broadcastHash || err.txHash;
      if (txHash) {
        await db.query('UPDATE managed_sends SET status=$2,tx_hash=$3,updated_at=now() WHERE operation=$1',
          [request.operation,err.reverted ? 'reverted' : 'submitted',txHash]);
        if (!err.reverted) return { txHash,pending:true,replayed:false };
      }
      throw err;
    }
  } finally {
    await releaseOperationLock(db,key);
  }
}
