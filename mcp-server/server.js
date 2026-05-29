/**
 * BARD MCP Server — hosted Streamable HTTP transport.
 *
 * Stateless. Every POST /mcp carries `Authorization: Bearer <BARD_TOKEN>` which
 * the handler forwards to the backend's /api/auth/me to authenticate the caller.
 * No DB connection here — the backend is the single source of truth.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { handleRpc } from '@bard/mcp-core';

const app = express();
const PORT = process.env.PORT || 4100;

app.set('trust proxy', 1);

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    const allowed = [...DEFAULT_ALLOWED_ORIGINS, ...ALLOWED_ORIGINS];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Accept'],
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'bard-mcp', api: process.env.BARD_API || null });
});

app.get('/mcp', (_req, res) => {
  res.json({
    name: 'bard-mcp',
    version: '0.3.0',
    transport: 'streamable-http',
    endpoint: '/mcp',
  });
});

app.post('/mcp', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  try {
    const result = await handleRpc(req.body, token);
    if (result === null) return res.status(204).end();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message },
    });
  }
});

app.listen(PORT, () => {
  console.log(`  → bard-mcp listening on :${PORT}`);
  console.log(`  → BARD_API = ${process.env.BARD_API || '(unset — will default to localhost:4000)'}`);
});
