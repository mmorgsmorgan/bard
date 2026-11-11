import express from 'express';
import { readPolicyTemplate, verifyEnvelope, signEnvelope, policyHash } from '../backend/vcr-policy.js';
import { checkRegistrySpend, setPolicyState } from '../backend/vcr-registry.js';

export function createVerifierApp({ pool, statePool = pool, secret, template = readPolicyTemplate() }) {
  // Validate the secret at startup, before reporting healthy.
  signEnvelope({},secret,'startup');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.get('/health',async (_req,res) => {
    try { await pool.query('SELECT 1 FROM vcr_policies LIMIT 0'); res.json({ status: 'ok', service: 'bard-vcr', template: template.template }); }
    catch { res.status(503).json({ status: 'starting' }); }
  });
  app.post(['/v1/verify','/v1/policies/enroll','/v1/policies/state'], async (req,res) => {
    let request;
    try {
      request = verifyEnvelope(req.body,secret,req.path);
      if (!Number.isSafeInteger(request.issuedAt) || Math.abs(Date.now()-request.issuedAt)>30_000 ||
          !/^[a-f0-9]{32}$/.test(request.nonce || '')) throw new Error('Invalid request');
      await pool.query('DELETE FROM vcr_service_nonces WHERE expires_at<now()');
      await pool.query(`INSERT INTO vcr_service_nonces(nonce,expires_at) VALUES($1,now()+interval '1 minute')`,[request.nonce]);
    } catch { return res.status(401).json({ error: 'VCR service authentication required.' }); }
    let result, failure;
    try {
      if (req.path === '/v1/verify') result = await checkRegistrySpend(pool,request.payload);
      else if (req.path === '/v1/policies/enroll') {
        const { agentId, wallet } = request.payload || {};
        result = await setPolicyState(statePool,{ agentId,wallet,action:'enroll',actor:'automatic' },template);
      } else result = await setPolicyState(statePool,request.payload,template);
    } catch (err) {
      failure = { error: err.status ? err.message : 'VCR registry unavailable.', code: err.code && err.status ? err.code : 'vcr_unavailable', status: err.status || 503 };
    }
    res.json(signEnvelope({ requestHash: policyHash(request), expiresAt: Date.now()+15_000,
      ...(failure || { result }) },secret,req.path+':response'));
  });
  app.use((err,_req,res,_next) => res.status(400).json({ error: 'Invalid verifier request.' }));
  return app;
}
