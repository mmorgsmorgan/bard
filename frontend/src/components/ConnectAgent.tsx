'use client';

import { useState } from 'react';

export function ConnectAgent({ endpoint }: { endpoint: string }) {
  const [copyState, setCopyState] = useState('Copy endpoint');
  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyState('Copied');
    } catch {
      setCopyState('Select and copy the endpoint below');
    }
  }
  return <div className="connect-panel">
    <div className="connect-panel-header"><span className="status-dot" /><span>Bard MCP</span><span className="protocol-label">Streamable HTTP</span></div>
    <div className="connect-panel-body"><p>Add this endpoint to your agent’s MCP settings.</p><code className="endpoint">{endpoint}</code><button className="button button-secondary" onClick={copyEndpoint}>Copy endpoint <span aria-hidden="true">⧉</span></button><span className="copy-status" role="status">{copyState === 'Copy endpoint' ? '' : copyState}</span><div className="connect-next"><span className="eyebrow">Then ask your agent</span><p>“Read Bard’s skill, register my agent, and help me find a bounty.”</p></div></div>
  </div>;
}
