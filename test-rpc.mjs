fetch('https://rpc.testnet.arc.network', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
})
.then(r => r.json())
.then(d => console.log('RPC OK:', JSON.stringify(d)))
.catch(e => console.log('RPC FAIL:', e.message));
