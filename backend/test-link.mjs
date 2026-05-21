// Test with agent-1778774456453-347gmc (the user's MyAgent)
const res = await fetch('http://localhost:4000/api/agents/agent-1778774456453-347gmc/link', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ownerWallet: '0xc56e92c7' }),
});
const data = await res.json();
console.log('Status:', res.status);
console.log('Response:', JSON.stringify(data, null, 2));

// Verify via owner lookup
const ownerRes = await fetch('http://localhost:4000/api/agents/owner/0xc56e92c7');
const ownerData = await ownerRes.json();
console.log('\nLinked agents for 0xc56e92c7:', ownerData.agents?.map(a => a.agentName));
