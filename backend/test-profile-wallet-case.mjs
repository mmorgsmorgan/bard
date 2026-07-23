#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import 'dotenv/config';

const { initSchema, pool, stmts } = await import('./db.js');
const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const username = `wallet-case-${suffix}`.slice(0, 32);
const mixedCaseWallet = '0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8';
const lowerCaseWallet = mixedCaseWallet.toLowerCase();
const otherWallet = '0xb1a16e5ee45a999845ef6c7cf99b16666b2ba3c8';

function profile(wallet, displayName, pfp) {
  return {
    wallet,
    username,
    display_name: displayName,
    bio: 'Recovered off-chain profile',
    profile_type: 'human',
    ecosystems: JSON.stringify(['Arc']),
    farcaster: '',
    github: '',
    x: '',
    discord: '',
    linkedin: '',
    pfp,
    created_at: new Date().toISOString(),
  };
}

try {
  await initSchema();
  await pool.query(
    `INSERT INTO profiles
       (wallet, username, display_name, bio, profile_type, ecosystems, pfp, created_at)
     VALUES ($1, $2, 'Original', '', 'human', '[]', '', NOW())`,
    [mixedCaseWallet, username]
  );

  const lowerCaseLookup = await stmts.getProfileByWallet(lowerCaseWallet);
  assert.equal(lowerCaseLookup.username, username);
  assert.equal(lowerCaseLookup.wallet, mixedCaseWallet);

  await stmts.upsertProfile(
    profile(lowerCaseWallet, 'Updated', 'https://example.com/new-pfp.jpg')
  );

  const rows = await pool.query(
    'SELECT * FROM profiles WHERE LOWER(wallet) = LOWER($1)',
    [lowerCaseWallet]
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].wallet, mixedCaseWallet);
  assert.equal(rows.rows[0].display_name, 'Updated');
  assert.equal(rows.rows[0].pfp, 'https://example.com/new-pfp.jpg');
  assert.deepEqual(JSON.parse(rows.rows[0].ecosystems), ['Arc']);

  await assert.rejects(
    stmts.upsertProfile(profile(otherWallet, 'Wrong owner', '')),
    (error) => error.code === '23505'
  );

  console.log('Profile wallet case tests passed');
} finally {
  await pool.query('DELETE FROM profiles WHERE username = $1', [username]);
  await pool.end();
}
