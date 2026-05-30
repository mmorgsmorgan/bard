import 'dotenv/config';

const API = 'http://localhost:4001';

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

async function get(path) {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, data: await res.json() };
}

async function testSwarmExecution() {
  console.log('\n🧪 Testing Swarm Execution Flow\n');

  // Step 1: Register a test user agent
  console.log('1️⃣  Registering test user agent...');
  const { status: regStatus, data: regData } = await post('/api/agents/register', {
    ownerWallet: '0xTestUser123',
    agentName: 'TestUserAgent',
    agentPublicKey: '0xTestUser123',
    agentType: 'general',
    description: 'Test user for swarm execution'
  });

  if (regStatus !== 200) {
    console.error('❌ Registration failed:', regData.error);
    return;
  }
  console.log(`✅ User agent registered: ${regData.agent.id}\n`);

  // Step 2: Create a bounty
  console.log('2️⃣  Creating bounty...');
  const { status: bountyStatus, data: bountyData } = await post('/api/bounties', {
    creatorWallet: '0xTestUser123',
    title: 'Test Swarm Task',
    description: 'Review this code snippet: function add(a, b) { return a + b; }',
    bountyType: 'code_review',
    amountUsdc: '10',
    deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
    minReputation: 0
  });

  if (bountyStatus !== 200) {
    console.error('❌ Bounty creation failed:', bountyData.error);
    return;
  }
  const bountyId = bountyData.bounty.id;
  console.log(`✅ Bounty created: ${bountyId}\n`);

  // Step 3: Fund the bounty
  console.log('3️⃣  Funding bounty...');
  const { status: fundStatus, data: fundData } = await post(`/api/bounties/${bountyId}/fund`, {
    clientWallet: '0xTestUser123',
    budgetUsdc: 10,
    txHash: 'test-tx-hash'
  });

  if (fundStatus !== 200) {
    console.error('❌ Funding failed:', fundData.error);
    return;
  }
  console.log(`✅ Bounty funded: ${fundData.bounty.escrow_budget_usdc} USDC\n`);

  // Step 4: Claim with platform swarm (Code Review Swarm)
  console.log('4️⃣  Claiming bounty with Code Review Swarm...');
  const { status: claimStatus, data: claimData } = await post(`/api/bounties/${bountyId}/claim`, {
    agentId: 'swarm-platform-code-review',
    callerWallet: '0xb93E4681a57e2bF801e223E1e0AE8e6c6E6e6e6e' // Platform owner wallet
  });

  if (claimStatus !== 200) {
    console.error('❌ Claim failed:', claimData.error);
    return;
  }
  console.log(`✅ Bounty claimed by swarm`);
  console.log(`   Execution ID: ${claimData.swarm_execution_id || 'N/A'}`);
  console.log(`   Status: ${claimData.swarm_status || claimData.bounty?.escrow_status}\n`);

  // Step 5: Check swarm_executions table
  console.log('5️⃣  Checking swarm_executions table...');
  const { status: execStatus, data: execData } = await get(`/api/bounties/${bountyId}/escrow`);

  if (execStatus === 200) {
    console.log(`✅ Bounty status: ${execData.bounty.escrow_status}`);
    console.log(`   Deliverable length: ${execData.bounty.deliverable_content?.length || 0} chars`);
    console.log(`   Swarm execution ID: ${execData.bounty.swarm_execution_id || 'N/A'}\n`);
  }

  // Step 6: Summary
  console.log('📊 Test Summary:');
  console.log(`   Bounty ID: ${bountyId}`);
  console.log(`   Swarm Agent: swarm-platform-code-review`);
  console.log(`   Execution triggered: ${claimData.swarm_execution_id ? 'YES' : 'NO'}`);
  console.log(`   Status: ${claimData.swarm_status || 'claimed'}`);

  if (claimData.swarm_status === 'completed') {
    console.log(`   ✅ Swarm execution completed successfully!`);
  } else if (claimData.swarm_status === 'failed') {
    console.log(`   ⚠️  Swarm execution failed (expected - no real Swarms API key)`);
  } else {
    console.log(`   ℹ️  Swarm execution in progress or pending`);
  }

  console.log('\n✨ Test complete!\n');
}

testSwarmExecution().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
