import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { createVerifierApp } from '../vcr-service/app.js';
import { CHAIN,policyHash,readPolicyTemplate,callVerifier,signEnvelope } from './vcr-policy.js';
import { registrySchema,setPolicyState,withActiveWallet } from './vcr-registry.js';
import { reserveSpend,spendingSchema } from './vcr-spending.js';
import { managedSendSchema,executeManagedSend,sendOperation } from './managed-send.js';
import { platformBudgetSchema,reservePlatformSpend } from './platform-budget.js';
import { getOrCreateAgentWallet } from './turnkey-wallet.js';
import { provisionVerifierRole } from './vcr-database-role.js';

if (!process.env.BARD_TEST_DATABASE_URL) throw new Error('Supply an explicitly disposable BARD_TEST_DATABASE_URL.');
const schema='policy_'+randomUUID().replaceAll('-','');
const setup=new pg.Pool({connectionString:process.env.BARD_TEST_DATABASE_URL,max:1});
const connection={connectionString:process.env.BARD_TEST_DATABASE_URL,options:'-c search_path='+schema};
const pool = new pg.Pool({...connection,max:20});
const verifierPool = new pg.Pool({...connection,max:5});
const suffix=randomUUID();
const template=readPolicyTemplate({AGENTIC_COMMERCE_ADDRESS:'0x'+'33'.repeat(20),BARD_JOB_HOOK_ADDRESS:'0x'+'44'.repeat(20),BARD_VCR_DAILY_USDC:'100'});
Object.assign(process.env,{BARD_VCR_MODE:'registry',BARD_VCR_SERVICE_SECRET:randomBytes(32).toString('hex'),WALLET_PROVIDER:'local',WALLET_MASTER_KEY:randomBytes(32).toString('hex')});
let server;
let restrictedPool;
try {
  await setup.query('CREATE SCHEMA '+schema);
  await pool.query(`CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,agent_name TEXT,owner_wallet TEXT NOT NULL,
    status TEXT DEFAULT 'active',turnkey_wallet_id TEXT,turnkey_address TEXT)`);
  await pool.query(spendingSchema+registrySchema+managedSendSchema+platformBudgetSchema);
  server=createVerifierApp({pool:verifierPool,secret:process.env.BARD_VCR_SERVICE_SECRET,template}).listen(0,'127.0.0.1');
  await once(server,'listening');
  process.env.BARD_VCR_URL='http://127.0.0.1:'+server.address().port;
  const agents=[];
  for(let i=0;i<3;i++) {
    const id='agent-'+suffix+'-'+i;
    await pool.query('INSERT INTO agents(id,agent_name,owner_wallet) VALUES($1,$2,$3)',[id,id,'0x'+'00'.repeat(20)]);
    // Concurrent callers must receive one durable wallet and one active policy.
    const wallets=await Promise.all(Array.from({length:8},()=>getOrCreateAgentWallet(pool,id,id)));
    assert.equal(new Set(wallets.map(w=>w.address)).size,1);
    assert.ok(wallets.every(w=>w.policy.status==='active'));
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM local_wallets WHERE label=$1',['bard-agent-'+id])).rows[0].n),1);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM vcr_policy_events WHERE agent_id=$1',[id])).rows[0].n),1);
    agents.push({id,address:wallets[0].address.toLowerCase()});
  }
  const [a,b,c]=agents;
  const rolePassword=randomBytes(32).toString('hex');
  await provisionVerifierRole(pool,{password:rolePassword,schema});
  const roleUrl=new URL(process.env.BARD_TEST_DATABASE_URL);
  roleUrl.username='bard_vcr';roleUrl.password=rolePassword;
  restrictedPool=new pg.Pool({connectionString:roleUrl.href,options:'-c search_path='+schema,max:5});
  await restrictedPool.query('SELECT id,turnkey_address,status,owner_wallet FROM agents');
  await assert.rejects(restrictedPool.query('SELECT enc_ct FROM local_wallets'),/permission denied/);
  await assert.rejects(restrictedPool.query('SELECT * FROM agents'),/permission denied/);
  await assert.rejects(restrictedPool.query("UPDATE agents SET status='inactive'"),/permission denied/);
  await assert.rejects(restrictedPool.query('DELETE FROM vcr_reservations'),/permission denied/);
  await new Promise(resolve=>server.close(resolve));
  server=createVerifierApp({pool:restrictedPool,secret:process.env.BARD_VCR_SERVICE_SECRET,template}).listen(0,'127.0.0.1');
  await once(server,'listening');
  process.env.BARD_VCR_URL='http://127.0.0.1:'+server.address().port;
  const url=process.env.BARD_VCR_URL;
  const pendingId='agent-pending-'+suffix;
  await pool.query('INSERT INTO agents(id,agent_name,owner_wallet) VALUES($1,$1,$2)',[pendingId,'0x'+'00'.repeat(20)]);
  process.env.BARD_VCR_URL='http://127.0.0.1:1';
  const offline=await getOrCreateAgentWallet(pool,pendingId,pendingId);
  assert.equal(offline.policy.status,'pending');
  process.env.BARD_VCR_URL=url;
  const enrolled=await getOrCreateAgentWallet(pool,pendingId,pendingId);
  assert.equal(enrolled.address,offline.address);assert.equal(enrolled.policy.status,'active');
  const request={agentId:a.id,wallet:a.address,recipient:b.address,amount:'60000000',operation:'send:'+suffix,purpose:'send',contextHash:policyHash({terms:'fixed'})};
  const outcomes=await Promise.allSettled([reserveSpend(pool,request),reserveSpend(pool,{...request,operation:request.operation+'b'})]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const accepted=outcomes[0].status==='fulfilled'?request:{...request,operation:request.operation+'b'};
  await reserveSpend(pool,accepted);
  await assert.rejects(reserveSpend(pool,{...accepted,amount:'1'}),/changed/);
  await assert.rejects(reserveSpend(pool,{...request,agentId:b.id}),/matching/);
  await assert.rejects(reserveSpend(pool,{...request,amount:'1',recipient:'0x'+'99'.repeat(20),operation:'other:'+suffix}),/Recipient/);
  await reserveSpend(pool,{...request,agentId:c.id,wallet:c.address,operation:'other-agent:'+suffix});
  await setPolicyState(pool,{agentId:a.id,wallet:a.address,action:'revoke',actor:'test'});
  const stillRevoked=await getOrCreateAgentWallet(pool,a.id,a.id);
  assert.equal(stillRevoked.policy.status,'revoked');
  await assert.rejects(reserveSpend(pool,accepted),/active/);
  await assert.rejects(withActiveWallet(pool,a.address,()=>{throw new Error('must not sign');}),/active/);
  await setPolicyState(pool,{agentId:a.id,wallet:a.address,action:'activate',actor:'operator'},template);
  await assert.rejects(reserveSpend(pool,{...request,operation:'after-reactivation:'+suffix}),/Daily/);
  assert.equal((await pool.query('SELECT version FROM vcr_policies WHERE agent_id=$1',[a.id])).rows[0].version,2);
  // Policy revision/content mismatches cannot be accepted, even from a service
  // holding the correct response-signing secret.
  await assert.rejects(reserveSpend(pool,accepted,{fetchImpl:async(_url,init)=>{
    const response=await fetch(url+'/v1/verify',init);
    const envelope=await response.json();
    envelope.value.result.policyVersion++;
    return Response.json(signEnvelope(envelope.value,process.env.BARD_VCR_SERVICE_SECRET,'/v1/verify:response'));
  }}),/does not match/);
  let entered,release;
  const began=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let revoked=false;
  const admitted=withActiveWallet(pool,b.address,async()=>{entered();await gate;});
  await began;
  const revocation=setPolicyState(pool,{agentId:b.id,wallet:b.address,action:'revoke',actor:'operator'}).then(()=>{revoked=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(revoked,false);
  release();await Promise.all([admitted,revocation]);
  await assert.rejects(withActiveWallet(pool,b.address,()=>{}),/active/);
  await setPolicyState(pool,{agentId:b.id,wallet:b.address,action:'activate',actor:'operator'},template);

  // Actual verifier rejects unauthenticated and replayed enrollment requests.
  const unauth=await fetch(process.env.BARD_VCR_URL+'/v1/policies/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:a.id,wallet:b.address})});
  assert.equal(unauth.status,401);
  await assert.rejects(callVerifier('/v1/policies/enroll',{agentId:a.id,wallet:b.address}),/own/);
  const envelope=signEnvelope({issuedAt:Date.now(),nonce:randomBytes(16).toString('hex'),payload:{...accepted,token:'USDC',chain:CHAIN}},process.env.BARD_VCR_SERVICE_SECRET,'/v1/verify');
  const post=()=>fetch(process.env.BARD_VCR_URL+'/v1/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope)});
  assert.equal((await post()).status,200);
  assert.equal((await post()).status,401);

  let sends=0;
  const sendReq={...request,operation:sendOperation(a.id,'payment-'+suffix)};
  const send=async hooks=>{await hooks.beforeBroadcast();sends++;await hooks.onBroadcast('0x'+'11'.repeat(32));return{txHash:'0x'+'11'.repeat(32)};};
  const retries=await Promise.all(Array.from({length:8},()=>executeManagedSend(pool,sendReq,send)));
  assert.equal(sends,1);assert.equal(new Set(retries.map(r=>r.txHash)).size,1);
  await assert.rejects(executeManagedSend(pool,{...sendReq,amount:'1'},send),/changed/);
  const uncertain={...sendReq,operation:sendOperation(a.id,'uncertain-'+suffix)};
  await assert.rejects(executeManagedSend(pool,uncertain,async hooks=>{await hooks.beforeBroadcast();throw new Error('connection lost without hash');}),/connection lost/);
  await assert.rejects(executeManagedSend(pool,uncertain,send),/reconciliation/);
  assert.equal(sends,1);
  const pending={...sendReq,operation:sendOperation(a.id,'pending-'+suffix)};
  const pendingResult=await executeManagedSend(pool,pending,async hooks=>{await hooks.beforeBroadcast();await hooks.onBroadcast('0x'+'22'.repeat(32));throw new Error('receipt timeout');});
  assert.equal(pendingResult.pending,true);
  assert.equal((await executeManagedSend(pool,pending,send,{receipt:async()=>({status:'success'})})).pending,false);
  assert.equal(sends,1);
  const preflight={...sendReq,operation:sendOperation(a.id,'preflight-'+suffix)};
  await assert.rejects(executeManagedSend(pool,preflight,async()=>{throw new Error('no gas');}),/no gas/);
  await executeManagedSend(pool,preflight,send);assert.equal(sends,2);

  // Competing policy locks must leave ordinary query connections available to
  // the admitted operation. Verify this with a single query connection.
  const queries=new pg.Pool({...connection,max:1});
  const locks=new pg.Pool({...connection,max:2});
  try {
    await Promise.all(Array.from({length:8},()=>withActiveWallet(locks,c.address,async()=>queries.query('SELECT 1'))));
  } finally { await Promise.all([queries.end(),locks.end()]); }

  const budgets={BARD_GAS_MAX_WEI:'60',BARD_GAS_DAILY_WEI:'100',BARD_GAS_WALLET_DAILY_WEI:'100'};
  const gas=await Promise.allSettled([reservePlatformSpend(pool,{kind:'gas',wallet:a.address,amount:60n},budgets),reservePlatformSpend(pool,{kind:'gas',wallet:b.address,amount:60n},budgets)]);
  assert.equal(gas.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(reservePlatformSpend(pool,{kind:'gas',wallet:c.address,amount:1n},{}),/disabled/);
  const operatorLimits={BARD_PLATFORM_MAX_WEI:'60',BARD_PLATFORM_DAILY_WEI:'100',BARD_PLATFORM_WALLET_DAILY_WEI:'100'};
  const previousDay={kind:'operator',wallet:c.address,amount:60n,operation:'previous-day-'+suffix};
  await reservePlatformSpend(pool,previousDay,operatorLimits);
  await pool.query('UPDATE platform_spend_reservations SET day=day-1 WHERE operation=$1',[previousDay.operation]);
  await reservePlatformSpend(pool,previousDay,operatorLimits);
  await assert.rejects(reservePlatformSpend(pool,{...previousDay,operation:'same-day-second-'+suffix},operatorLimits),/daily/);
  console.log('Managed policy tests passed: concurrent provisioning, authenticated enrollment, revocation, independent and aggregate budgets, retry idempotency, pending/uncertain sends.');
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  await Promise.all([pool.end(),verifierPool.end(),restrictedPool?.end()]);
  await setup.query('DROP SCHEMA '+schema+' CASCADE');
  await setup.end();
}
