#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import 'dotenv/config';

process.env.WALLET_PROVIDER = 'local';
process.env.WALLET_MASTER_KEY ||= '42'.repeat(32);

const [{ initSchema, pool }, { humanAuthTestUtils }, walletService] = await Promise.all([
  import('./db.js'),
  import('./human-auth.js'),
  import('./human-wallet-service.js'),
]);

const {
  identityFromPrivyUser,
  requireLoginContext,
  requestedWallet,
  upsertHumanAccount,
} = humanAuthTestUtils;
const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const ids = {
  emailDid: `did:privy:test-email-${suffix}`,
  externalDid: `did:privy:test-external-${suffix}`,
  legacyDid: `did:privy:test-legacy-${suffix}`,
  profile: `account-mode-${suffix}`.slice(0, 32),
  proof: `proof-account-mode-${suffix}`,
  portfolio: `portfolio-account-mode-${suffix}`,
  notification: `notification-account-mode-${suffix}`,
  agent: `agent-account-mode-${suffix}`,
  bounty: `bounty-account-mode-${suffix}`,
  message: `message-account-mode-${suffix}`,
};
const externalAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const legacyExternalAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const createdHumanIds = [];
const createdLocalWallets = [];

async function cleanup() {
  await pool.query('DELETE FROM bounty_messages WHERE id = $1', [ids.message]);
  await pool.query('DELETE FROM bounties WHERE id = $1', [ids.bounty]);
  await pool.query('DELETE FROM agents WHERE id = $1', [ids.agent]);
  await pool.query('DELETE FROM notifications WHERE id = $1', [ids.notification]);
  await pool.query('DELETE FROM portfolio WHERE id = $1', [ids.portfolio]);
  await pool.query('DELETE FROM proofs WHERE id = $1', [ids.proof]);
  await pool.query('DELETE FROM profiles WHERE username = $1', [ids.profile]);
  if (createdHumanIds.length > 0) {
    await pool.query(
      `DELETE FROM human_tx_confirmations WHERE human_id = ANY($1::text[])`,
      [createdHumanIds]
    );
    await pool.query(
      `DELETE FROM human_security_events WHERE human_id = ANY($1::text[])`,
      [createdHumanIds]
    );
    await pool.query(
      `DELETE FROM human_otp_codes WHERE human_id = ANY($1::text[])`,
      [createdHumanIds]
    );
    await pool.query('DELETE FROM human_accounts WHERE id = ANY($1::text[])', [createdHumanIds]);
  }
  if (createdLocalWallets.length > 0) {
    await pool.query(
      'DELETE FROM local_wallets WHERE address = ANY($1::text[])',
      [createdLocalWallets]
    );
  }
}

try {
  await initSchema();

  const tokenIssuedAt = Math.floor(Date.now() / 1000);
  const staleVerification = new Date((tokenIssuedAt * 1000) - (10 * 60 * 1000));
  const currentVerification = new Date((tokenIssuedAt * 1000) - 1_000);
  const privyIdentity = identityFromPrivyUser({
    email: { address: `Test-${suffix}@example.com` },
    wallet: {
      type: 'wallet',
      chainType: 'ethereum',
      walletClientType: 'privy',
      address: privateKeyToAccount(generatePrivateKey()).address,
    },
    linkedAccounts: [
      {
        type: 'email',
        address: `Test-${suffix}@example.com`,
        firstVerifiedAt: new Date(),
        latestVerifiedAt: staleVerification,
      },
      {
        type: 'wallet',
        chainType: 'ethereum',
        walletClientType: 'privy',
        address: privateKeyToAccount(generatePrivateKey()).address,
      },
      {
        type: 'wallet',
        chainType: 'solana',
        walletClientType: 'phantom',
        address: 'not-an-evm-address',
      },
      {
        type: 'wallet',
        chainType: 'ethereum',
        walletClientType: 'rabby_wallet',
        address: externalAddress,
        latestVerifiedAt: currentVerification,
      },
    ],
  }, {
    userId: `did:privy:identity-${suffix}`,
    issuedAt: tokenIssuedAt,
  });
  assert.deepEqual(privyIdentity.externalWallets, [externalAddress]);
  assert.equal(privyIdentity.email, `test-${suffix}@example.com`);
  assert.equal(privyIdentity.authenticatedEmail, false);
  assert.deepEqual(privyIdentity.authenticatedExternalWallets, [externalAddress]);
  assert.deepEqual(
    requireLoginContext({ loginMethod: 'siwe', loginWallet: externalAddress }),
    { loginMethod: 'siwe', loginWallet: externalAddress }
  );
  assert.throws(
    () => requireLoginContext({}),
    (error) => error.code === 'login_method_required'
  );

  assert.deepEqual(
    requestedWallet(privyIdentity, null, {
      loginMethod: 'siwe',
      loginWallet: externalAddress,
    }),
    { type: 'external', address: externalAddress }
  );
  assert.throws(
    () => requestedWallet(privyIdentity, null, { loginMethod: 'email' }),
    (error) => error.code === 'email_login_mismatch'
  );
  const emailPrivyIdentity = identityFromPrivyUser({
    linkedAccounts: [
      {
        type: 'email',
        address: `Test-${suffix}@example.com`,
        latestVerifiedAt: currentVerification,
      },
      {
        type: 'wallet',
        chainType: 'ethereum',
        walletClientType: 'rabby_wallet',
        address: externalAddress,
        latestVerifiedAt: staleVerification,
      },
    ],
  }, {
    userId: `did:privy:email-identity-${suffix}`,
    issuedAt: tokenIssuedAt,
  });
  assert.deepEqual(
    requestedWallet(emailPrivyIdentity, null, { loginMethod: 'email' }),
    { type: 'managed', address: null }
  );
  assert.throws(
    () => requestedWallet(emailPrivyIdentity, null, {
      loginMethod: 'siwe',
      loginWallet: externalAddress,
    }),
    (error) => error.code === 'wallet_login_mismatch'
  );
  assert.throws(
    () => requestedWallet(privyIdentity, {
      wallet_type: 'managed',
      wallet_address: privateKeyToAccount(generatePrivateKey()).address,
    }, {
      loginMethod: 'siwe',
      loginWallet: externalAddress,
    }),
    (error) => error.code === 'account_login_method_mismatch'
  );
  assert.throws(
    () => requestedWallet(emailPrivyIdentity, {
      wallet_type: 'external',
      wallet_address: externalAddress,
    }, { loginMethod: 'email' }),
    (error) => error.code === 'account_login_method_mismatch'
  );
  assert.throws(
    () => requestedWallet(privyIdentity, null, {
      loginMethod: 'siwe',
      loginWallet: privateKeyToAccount(generatePrivateKey()).address,
    }),
    (error) => error.code === 'wallet_login_mismatch'
  );

  const emailAccount = await upsertHumanAccount({
    privyDid: ids.emailDid,
    email: `email-${suffix}@example.com`,
    emailVerifiedAt: new Date().toISOString(),
    loginWallet: null,
    externalWallets: [],
    authenticatedEmail: true,
    authenticatedExternalWallets: [],
  }, { loginMethod: 'email' });
  createdHumanIds.push(emailAccount.id);
  createdLocalWallets.push(emailAccount.wallet_address.toLowerCase());
  assert.equal(emailAccount.wallet_type, 'managed');
  assert.match(emailAccount.wallet_id, /^lw-/);
  assert.match(emailAccount.wallet_address, /^0x[0-9a-f]{40}$/);

  const externalAccount = await upsertHumanAccount({
    privyDid: ids.externalDid,
    email: null,
    emailVerifiedAt: null,
    loginWallet: externalAddress,
    externalWallets: [externalAddress],
    authenticatedEmail: false,
    authenticatedExternalWallets: [externalAddress],
  }, {
    loginMethod: 'siwe',
    loginWallet: externalAddress,
  });
  createdHumanIds.push(externalAccount.id);
  assert.equal(externalAccount.wallet_type, 'external');
  assert.equal(externalAccount.wallet_address, externalAddress);
  assert.equal(externalAccount.wallet_id, null);
  const unexpectedExternalWallet = await pool.query(
    'SELECT 1 FROM local_wallets WHERE label = $1',
    [`bard-human-${externalAccount.id}`]
  );
  assert.equal(unexpectedExternalWallet.rowCount, 0);

  const provider = (await import('./wallet-provider.js')).getWalletProvider(pool);
  const legacyWallet = await provider.createWallet(`legacy-account-mode-${suffix}`);
  createdLocalWallets.push(legacyWallet.address.toLowerCase());
  const legacyHumanId = `human-legacy-${suffix}`;
  createdHumanIds.push(legacyHumanId);
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO human_accounts
       (id, privy_did, email, email_verified_at, login_wallet, wallet_type,
        wallet_id, wallet_address, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, LOWER($6), $7, $7)`,
    [
      legacyHumanId,
      ids.legacyDid,
      `legacy-${suffix}@example.com`,
      now,
      legacyWallet.walletId,
      legacyWallet.address,
      now,
    ]
  );
  await pool.query(
    `INSERT INTO profiles
       (wallet, username, display_name, bio, profile_type, ecosystems, created_at)
     VALUES (LOWER($1), $2, 'Legacy Test', '', 'human', '[]', $3)`,
    [legacyWallet.address, ids.profile, now]
  );
  await pool.query(
    `INSERT INTO proofs
       (id, title, contributor, status, timestamp)
     VALUES ($1, 'Legacy proof', LOWER($2), 'unvalidated', $3)`,
    [ids.proof, legacyWallet.address, now]
  );
  await pool.query(
    `INSERT INTO portfolio
       (id, wallet, title, created_at)
     VALUES ($1, LOWER($2), 'Legacy portfolio', $3)`,
    [ids.portfolio, legacyWallet.address, now]
  );
  await pool.query(
    `INSERT INTO notifications
       (id, wallet, type, title, created_at)
     VALUES ($1, LOWER($2), 'system', 'Legacy notification', $3)`,
    [ids.notification, legacyWallet.address, now]
  );
  await pool.query(
    `INSERT INTO agents
       (id, owner_wallet, agent_name, agent_public_key, created_at)
     VALUES ($1, LOWER($2), 'Legacy agent', LOWER($2), $3)`,
    [ids.agent, legacyWallet.address, now]
  );
  await pool.query(
    `INSERT INTO bounties
       (id, creator_wallet, title, bounty_type, amount_usdc, deadline, created_at, updated_at)
     VALUES ($1, LOWER($2), 'Legacy bounty', 'research', '1', $3, $4, $4)`,
    [ids.bounty, legacyWallet.address, new Date(Date.now() + 86_400_000).toISOString(), now]
  );
  await pool.query(
    `INSERT INTO bounty_messages
       (id, bounty_id, from_wallet, to_wallet, message, created_at)
     VALUES ($1, $2, LOWER($3), LOWER($3), 'Legacy message', $4)`,
    [ids.message, ids.bounty, legacyWallet.address, now]
  );
  const fundingTxHash = `0x${randomBytes(32).toString('hex')}`;
  await pool.query(
    `INSERT INTO bounty_funding_transactions
       (tx_hash, bounty_id, funder_wallet, amount_usdc, created_at)
     VALUES ($1, $2, LOWER($3), 1, $4)`,
    [fundingTxHash, ids.bounty, legacyWallet.address, now]
  );

  const unclassified = await upsertHumanAccount({
    privyDid: ids.legacyDid,
    email: `legacy-${suffix}@example.com`,
    emailVerifiedAt: now,
    loginWallet: legacyExternalAddress,
    externalWallets: [legacyExternalAddress],
    authenticatedEmail: true,
    authenticatedExternalWallets: [],
  }, {});
  assert.equal(unclassified.wallet_type, null);
  assert.equal(unclassified.wallet_address, legacyWallet.address.toLowerCase());
  assert.equal(unclassified.wallet_id, legacyWallet.walletId);

  const migrated = await upsertHumanAccount({
    privyDid: ids.legacyDid,
    email: `legacy-${suffix}@example.com`,
    emailVerifiedAt: now,
    loginWallet: legacyExternalAddress,
    externalWallets: [legacyExternalAddress],
    authenticatedEmail: false,
    authenticatedExternalWallets: [legacyExternalAddress],
  }, {
    loginMethod: 'siwe',
    loginWallet: legacyExternalAddress,
  });
  assert.equal(migrated.wallet_type, 'external');
  assert.equal(migrated.wallet_address, legacyExternalAddress);
  assert.equal(migrated.wallet_id, null);
  assert.equal(migrated.legacy_wallet_id, legacyWallet.walletId);
  assert.equal(migrated.legacy_wallet_address, legacyWallet.address.toLowerCase());

  const ownershipChecks = await Promise.all([
    pool.query('SELECT wallet FROM profiles WHERE username = $1', [ids.profile]),
    pool.query('SELECT contributor AS wallet FROM proofs WHERE id = $1', [ids.proof]),
    pool.query('SELECT wallet FROM portfolio WHERE id = $1', [ids.portfolio]),
    pool.query('SELECT wallet FROM notifications WHERE id = $1', [ids.notification]),
    pool.query('SELECT owner_wallet AS wallet FROM agents WHERE id = $1', [ids.agent]),
    pool.query('SELECT creator_wallet AS wallet FROM bounties WHERE id = $1', [ids.bounty]),
    pool.query(
      'SELECT funder_wallet AS wallet FROM bounty_funding_transactions WHERE bounty_id = $1',
      [ids.bounty]
    ),
    pool.query('SELECT from_wallet, to_wallet FROM bounty_messages WHERE id = $1', [ids.message]),
  ]);
  for (const result of ownershipChecks.slice(0, -1)) {
    assert.equal(result.rows[0].wallet, legacyExternalAddress);
  }
  assert.equal(ownershipChecks.at(-1).rows[0].from_wallet, legacyExternalAddress);
  assert.equal(ownershipChecks.at(-1).rows[0].to_wallet, legacyExternalAddress);

  const transfer = walletService.buildHumanUsdcTransfer(externalAddress, '1.25');
  const validTransaction = {
    from: legacyExternalAddress,
    to: transfer.to,
    input: transfer.data,
    value: 0n,
  };
  assert.equal(walletService.validateExternalTransactionDetails({
    receipt: { status: 'success' },
    transaction: validTransaction,
    expectedFrom: legacyExternalAddress,
    expectedTo: transfer.to,
    acceptedData: transfer.data,
  }).valid, true);
  assert.equal(walletService.validateExternalTransactionDetails({
    receipt: { status: 'success' },
    transaction: { ...validTransaction, from: externalAddress },
    expectedFrom: legacyExternalAddress,
    expectedTo: transfer.to,
    acceptedData: transfer.data,
  }).valid, false);
  assert.equal(walletService.validateExternalTransactionDetails({
    receipt: { status: 'success' },
    transaction: { ...validTransaction, value: 1n },
    expectedFrom: legacyExternalAddress,
    expectedTo: transfer.to,
    acceptedData: transfer.data,
  }).valid, false);
  assert.equal(walletService.validateExternalTransactionDetails({
    receipt: { status: 'success' },
    transaction: { ...validTransaction, input: '0x1234' },
    expectedFrom: legacyExternalAddress,
    expectedTo: transfer.to,
    acceptedData: transfer.data,
  }).valid, false);

  console.log('Human account mode tests passed');
} finally {
  await cleanup();
  await pool.end();
}
