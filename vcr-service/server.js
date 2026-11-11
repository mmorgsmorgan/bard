import pg from 'pg';
import { createVerifierApp } from './app.js';

// This service never imports db.js (which runs marketplace workers), has no
// wallet master key, and should use a role restricted to policy tables.
if (!process.env.DATABASE_URL) throw new Error('Verifier DATABASE_URL is required.');
if (process.env.WALLET_MASTER_KEY) throw new Error('Do not give the VCR verifier wallet signing secrets.');
if (new URL(process.env.DATABASE_URL).username !== 'bard_vcr') throw new Error('Use the restricted bard_vcr database role for the verifier.');
const database = { connectionString:process.env.DATABASE_URL,
  ssl:process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : false };
const pool = new pg.Pool({ ...database,max:8 });
const statePool = new pg.Pool({ ...database,max:4 });
for (const connections of [pool,statePool]) connections.on('error', () => console.error('VCR database connection closed.'));
const app = createVerifierApp({ pool, statePool, secret: process.env.BARD_VCR_SERVICE_SECRET });
const server = app.listen(Number(process.env.PORT || 4200), '::', () => console.log('BARD VCR verifier listening.'));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close(async () => {
  await Promise.allSettled([pool.end(),statePool.end()]); process.exit(0);
}));
