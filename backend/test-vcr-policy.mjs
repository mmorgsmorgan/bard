import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { CHAIN,checkPolicy,makePolicy,policyHash,readPolicyTemplate,signEnvelope,verifyEnvelope,usdcUnits,callVerifier } from './vcr-policy.js';

const wallet = '0x'+'11'.repeat(20), recipient = '0x'+'22'.repeat(20);
const template = readPolicyTemplate({ AGENTIC_COMMERCE_ADDRESS:'0x'+'33'.repeat(20),BARD_JOB_HOOK_ADDRESS:'0x'+'44'.repeat(20) });
const policy = makePolicy('agent-a',wallet,1,template);
const request = { agentId:'agent-a',wallet,recipient,amount:'1000000',operation:'send:example',purpose:'send',token:'USDC',chain:CHAIN,contextHash:policyHash({ transaction:1 }) };

test('bounded policies deny foreign identity, chain, token, unapproved recipients and bad amounts',() => {
  const context = { dailySpent:'0',activeRecipient:true };
  assert.equal(checkPolicy(policy,request,context).allowed,true);
  for (const change of [{agentId:'agent-b'},{wallet:recipient},{chain:'base'},{token:'ETH'},
    {amount:'0'},{amount:'-1'},{amount:'1.1'},{amount:'100000001'},{contextHash:'invalid'},{purpose:'swap'}]) {
    assert.throws(() => checkPolicy(policy,{...request,...change},context));
  }
  assert.throws(() => checkPolicy(policy,request,{dailySpent:'0'}),/Recipient/);
  assert.throws(() => checkPolicy(policy,request,{...context,dailySpent:'250000000'}),/Daily/);
  assert.equal(checkPolicy(policy,request,{dailySpent:'0',ownerWallet:recipient}).allowed,true);
  assert.throws(() => checkPolicy(policy,{...request,recipient:wallet},context),/Recipient/);
  assert.equal(checkPolicy(policy,{...request,purpose:'escrow',recipient:template.constraints.contracts.escrow},{dailySpent:'0'}).allowed,true);
  assert.throws(() => checkPolicy(policy,{...request,purpose:'fee',recipient:template.constraints.contracts.escrow},context),/Recipient/);
});

test('USDC parsing never rounds or accepts exponent/trailing text',() => {
  assert.equal(usdcUnits('0.000001'),1n);
  assert.equal(usdcUnits('100.000000'),100000000n);
  for(const value of ['0','0.0000001','-1','1e2','1foo','1.1.1','01',' 1',1,NaN]) assert.throws(() => usdcUnits(value));
  assert.throws(() => readPolicyTemplate({...template,BARD_VCR_ALLOWED_RECIPIENTS:'["*"]'}));
});

test('service envelopes bind contents and endpoint',() => {
  const secret = randomBytes(32).toString('hex');
  const signed = signEnvelope({request},secret,'/v1/verify');
  assert.deepEqual(verifyEnvelope(signed,secret,'/v1/verify'),{request});
  assert.throws(() => verifyEnvelope(signed,secret,'/v1/policies/state'));
  assert.throws(() => verifyEnvelope({...signed,value:{request:{...request,amount:'2'}}},secret,'/v1/verify'));
  assert.throws(() => verifyEnvelope(signed,randomBytes(32).toString('hex'),'/v1/verify'));
});

test('client fails closed on missing URL, outages, forged, stale and mismatched responses',async () => {
  const secret = randomBytes(32).toString('hex');
  const opts = {secret,verifierUrl:'http://127.0.0.1:1'};
  await assert.rejects(callVerifier('/v1/verify',request,{...opts,verifierUrl:''}),/configuration/);
  await assert.rejects(callVerifier('/v1/verify',request,{...opts,fetchImpl:async()=>{throw new Error('down');}}),/unavailable/);
  await assert.rejects(callVerifier('/v1/verify',request,{...opts,fetchImpl:async()=>Response.json({allowed:true})}),/Invalid/);
  for(const change of [{expiresAt:Date.now()-1},{requestHash:'wrong'}]) {
    await assert.rejects(callVerifier('/v1/verify',request,{...opts,fetchImpl:async(_url,init)=>{
      const {value}=JSON.parse(init.body);
      return Response.json(signEnvelope({requestHash:policyHash(value),expiresAt:Date.now()+10000,result:{allowed:true},...change},secret,'/v1/verify:response'));
    }}),/Stale or mismatched/);
  }
});
