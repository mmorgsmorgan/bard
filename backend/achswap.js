// Achswap helpers — DEX integration for BARD agents on Arc Testnet.
//
// Achswap publishes an MCP server at https://api.achswapfi.xyz/mcp/message
// whose signing tools require X-Private-Key. BARD agents hold their keys in
// Turnkey, so we proxy only the read tools (quote, token-info, token-holders,
// tx-history) and build the swap tx ourselves against the on-chain adapter,
// signed via the same Turnkey path used in /api/agents/:id/send-usdc.
//
// AchSwapAdapter selectors (resolved via OpenChain from unverified bytecode,
// confirmed against live tx 0x46808617b7b9451cc2649bf85633df5f44f646a9e4ab30a76c155ac429308ccf):
//   swap(address tokenIn, address tokenOut, uint256 amountIn,
//        uint256 minAmountOut, address recipient, bytes routeData)
//     selector 0xb69cbf9f
//   quote(address tokenIn, address tokenOut, uint256 amountIn) → off-chain
//     route_data returned by quote_adapter MCP tool matches this `routeData` arg.

export const ACHSWAP_MCP_URL = 'https://api.achswapfi.xyz/mcp/message';
export const ACHSWAP_ADAPTER = '0xF82c88FbF46E109a3865647E5c4d4834b31f8AFB';
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
export const MAX_UINT256 = (1n << 256n) - 1n;

// Token symbols → addresses. Native USDC uses the zero address sentinel,
// which the adapter accepts directly (it handles the wrap to wUSDC).
export const KNOWN_TOKENS = {
  USDC:  '0x0000000000000000000000000000000000000000',
  WUSDC: '0xDe5DB9049a8dd344dC1B7Bbb098f9da60930A6dA',
  ACHS:  '0x45Bb5425f293bdd209c894364C462421FF5FfA48',
};

export const ADAPTER_ABI = [
  {
    name: 'swap',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'routeData', type: 'bytes' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

export const ERC20_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'Transfer',
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
];

// Resolve a token symbol or 0x address to a canonical 0x address.
// Throws on unknown symbol.
export function resolveToken(input) {
  if (!input) throw new Error('Token required');
  const s = String(input).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  const upper = s.toUpperCase();
  if (KNOWN_TOKENS[upper]) return KNOWN_TOKENS[upper].toLowerCase();
  throw new Error(`Unknown token "${input}" — pass a 0x address or one of: ${Object.keys(KNOWN_TOKENS).join(', ')}`);
}

// Drive Achswap's MCP JSON-RPC endpoint. No auth required for read tools.
export async function achswapCall(toolName, args) {
  const res = await fetch(ACHSWAP_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`Achswap MCP HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Achswap ${toolName}: ${data.error.message || JSON.stringify(data.error)}`);
  }
  const text = data.result?.content?.[0]?.text;
  if (text) {
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  return data.result;
}
