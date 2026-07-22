// escrow-service.js — on-chain escrow engine for BARD (migration Phase 1).
//
// Drives the ERC-8183 (AgenticCommerce) + BardJobHookV2 escrow stack. Each lifecycle
// leg is signed by its real owner through Turnkey:
//   - creator legs (createJob, configureBardJob, setProvider, approve+depositFee,
//     approve+fund)         -> signed by the creator agent's Turnkey wallet
//   - provider legs (setBudget, submit) -> provider agent's Turnkey wallet
//   - evaluator legs (complete, reject) -> platform wallet (SELLER_ADDRESS)
//   - refunds (claimRefund, refundFee)  -> anyone (we use the platform wallet)
//
// Agent<->agent bounties therefore go fully trustless on-chain with no user signing.
// Custody of the agent's earnings lives in the ERC-8183 contract; the platform fee
// lives in BardJobHookV2. The platform wallet only signs the evaluator verdict.
//
// This module is intentionally standalone (imported by server.js routes behind a
// flag) so the custodial path is untouched.

import {
  AGENTIC_COMMERCE_ADDRESS, BARD_JOB_HOOK_ADDRESS, USDC_ADDRESS,
  publicClient, hashTag,
  buildCreateJobCalldata, buildConfigureBardJobCalldata, buildSetProviderCalldata,
  buildSetBudgetCalldata, buildApproveCalldata, buildDepositFeeCalldata,
  buildFundCalldata, buildSubmitCalldata, buildCompleteCalldata,
  buildRejectCalldata, buildClaimRefundCalldata, buildRefundFeeCalldata,
  getJob as readJob, getFeeMeta as readFeeMeta,
} from './erc8183-client.js';

const ARC_RPC = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const SELLER_ADDRESS = process.env.SELLER_ADDRESS; // platform / evaluator wallet (Turnkey)
const USDC_DECIMALS = 6;

const ARC_CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
};

const GAS_LIMIT_BUFFER_BPS = BigInt(process.env.GAS_LIMIT_BUFFER_BPS || '12000');
const GAS_PRICE_BUFFER_BPS = BigInt(process.env.GAS_PRICE_BUFFER_BPS || '12500');
const GAS_RESERVE_WEI = BigInt(process.env.GAS_RESERVE_WEI || '2000000000000000');
const BPS_DENOMINATOR = 10_000n;
const ARC_TX_PACE_MS = (() => {
  const value = Number(process.env.ARC_TX_PACE_MS || '2000');
  return Number.isFinite(value) && value >= 0 ? value : 2000;
})();

export function toUsdcWei(amountUsdc) {
  return BigInt(Math.round(Number(amountUsdc) * 10 ** USDC_DECIMALS));
}
export function fromUsdcWei(wei) {
  return Number(wei) / 10 ** USDC_DECIMALS;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const _walletQueues = new Map();
let _arcTxQueue = Promise.resolve();
let _lastArcTxCompletedAt = 0;

function ceilDiv(value, divisor) {
  return (value + divisor - 1n) / divisor;
}

function buffered(value, basisPoints) {
  return ceilDiv(value * basisPoints, BPS_DENOMINATOR);
}

async function withWalletQueue(address, operation) {
  const key = address.toLowerCase();
  const previous = _walletQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  _walletQueues.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (_walletQueues.get(key) === current) _walletQueues.delete(key);
  }
}

function errorChain(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    values.push(current.code, current.message, current.details, current.shortMessage);
    current = current.cause;
  }
  return values.filter(value => value !== undefined && value !== null).join(' ');
}

export function isTransientArcRpcError(error) {
  const detail = errorChain(error);
  return /-32011|request limit|rate limit|too many requests|\b429\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up/i.test(detail);
}

export function arcRpcRetryDelay(attempt, baseDelayMs = 500, maxDelayMs = 8_000) {
  const attemptIndex = Math.max(0, Number(attempt) - 1);
  const base = Math.max(0, Number(baseDelayMs) || 0);
  const maximum = Math.max(0, Number(maxDelayMs) || 0);
  return Math.min(base * (2 ** attemptIndex), maximum);
}

export function arcTxPaceDelay(lastCompletedAt, now = Date.now(), paceMs = ARC_TX_PACE_MS) {
  const last = Number(lastCompletedAt) || 0;
  const current = Number(now) || 0;
  const pace = Math.max(0, Number(paceMs) || 0);
  return Math.max(0, last + pace - current);
}

export async function withArcRpcRetry(operation, {
  label = 'Arc RPC request',
  attempts = 8,
  baseDelayMs = 500,
  sleepFn = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientArcRpcError(error) || attempt === attempts) throw error;
      const delayMs = arcRpcRetryDelay(attempt, baseDelayMs);
      console.warn(`[Arc RPC] ${label} transient failure (${attempt}/${attempts}): ${error.shortMessage || error.message}. Retrying in ${delayMs}ms.`);
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

async function withArcTransactionPacing(operation) {
  const previous = _arcTxQueue;
  let release;
  const current = new Promise(resolve => { release = resolve; });
  _arcTxQueue = current;
  await previous.catch(() => {});
  try {
    const delayMs = arcTxPaceDelay(_lastArcTxCompletedAt);
    if (delayMs > 0) await sleep(delayMs);
    return await operation();
  } finally {
    _lastArcTxCompletedAt = Date.now();
    release();
    if (_arcTxQueue === current) _arcTxQueue = Promise.resolve();
  }
}

async function waitForReceipt(txHash, label) {
  try {
    return await withArcRpcRetry(
      () => publicClient.waitForTransactionReceipt({ hash: txHash }),
      { label: `${label} receipt` },
    );
  } catch (cause) {
    const error = new Error(`${label} transaction was broadcast, but confirmation could not be read. Check ${txHash} before retrying.`);
    error.code = 'ARC_TX_CONFIRMATION_PENDING';
    error.txHash = txHash;
    error.cause = cause;
    throw error;
  }
}

// ──────────────────────────────────────────────
//  Turnkey signer cache
// ──────────────────────────────────────────────
let _tk = null;
const _walletClients = new Map();

async function turnkey() {
  if (_tk) return _tk;
  const { Turnkey } = await import('@turnkey/sdk-server');
  _tk = new Turnkey({
    defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
    apiBaseUrl: 'https://api.turnkey.com',
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
  });
  return _tk;
}

/**
 * viem walletClient that signs with the given wallet address.
 *
 * Default (WALLET_PROVIDER unset/turnkey): the original Turnkey path, untouched.
 * WALLET_PROVIDER=local|hybrid: delegate to wallet-provider.js so escrow signs
 * through the self-hosted (or hybrid) provider instead of Turnkey — same interface.
 */
async function signerFor(address) {
  const key = address.toLowerCase();
  if (_walletClients.has(key)) return _walletClients.get(key);

  const mode = (process.env.WALLET_PROVIDER || 'turnkey').toLowerCase();
  if (mode === 'local' || mode === 'hybrid') {
    const { getWalletProvider } = await import('./wallet-provider.js');
    const { pool } = await import('./db.js');
    const wc = await getWalletProvider(pool).getSigner(address);
    _walletClients.set(key, wc);
    return wc;
  }

  const { createAccount } = await import('@turnkey/viem');
  const { createWalletClient, http } = await import('viem');
  const tk = await turnkey();
  const account = await createAccount({
    client: tk.apiClient(),
    organizationId: process.env.TURNKEY_ORGANIZATION_ID,
    signWith: address,
  });
  const wc = createWalletClient({ account, chain: ARC_CHAIN, transport: http(ARC_RPC) });
  _walletClients.set(key, wc);
  return wc;
}

/**
 * Sign+send one calldata leg as `signer`, wait for the receipt, and throw on revert.
 * @returns {Promise<{txHash: string, receipt: object}>}
 */
export async function sendAs(signer, { to, data, value = 0n }, label = 'tx') {
  if (!signer) throw new Error(`escrow-service: missing signer for ${label}`);
  return withArcTransactionPacing(() => withWalletQueue(signer, async () => {
    const wc = await signerFor(signer);
    const gasFunding = await ensureGasForTransaction(signer, { to, data, value }, { label });
    const txHash = await wc.sendTransaction({
      to,
      data,
      value,
      gas: gasFunding.gasLimit,
      gasPrice: gasFunding.bufferedGasPrice,
    });
    const receipt = await waitForReceipt(txHash, label);
    if (receipt.status !== 'success') {
      throw new Error(`escrow-service: ${label} reverted (tx ${txHash})`);
    }
    return { txHash, receipt, gasFunding };
  }));
}

// ──────────────────────────────────────────────
//  Gas / balance helpers
// ──────────────────────────────────────────────

export async function usdcBalance(address) {
  const raw = await withArcRpcRetry(() => publicClient.readContract({
    address: USDC_ADDRESS,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [address],
  }), { label: `USDC balance for ${address}` });
  return BigInt(raw);
}

export async function nativeBalance(address) {
  return withArcRpcRetry(
    () => publicClient.getBalance({ address }),
    { label: `native balance for ${address}` },
  );
}

export async function getJob(jobId) {
  return withArcRpcRetry(() => readJob(jobId), { label: `job ${jobId} read` });
}

export async function getFeeMeta(jobId) {
  return withArcRpcRetry(() => readFeeMeta(jobId), { label: `job ${jobId} fee read` });
}

export function calculateGasFundingPlan({
  balance,
  estimatedGas,
  gasPrice,
  value = 0n,
  gasLimitBufferBps = GAS_LIMIT_BUFFER_BPS,
  gasPriceBufferBps = GAS_PRICE_BUFFER_BPS,
  reserveWei = GAS_RESERVE_WEI,
}) {
  const gasLimit = buffered(BigInt(estimatedGas), BigInt(gasLimitBufferBps));
  const bufferedGasPrice = buffered(BigInt(gasPrice), BigInt(gasPriceBufferBps));
  const requiredBalance = BigInt(value) + (gasLimit * bufferedGasPrice) + BigInt(reserveWei);
  const currentBalance = BigInt(balance);
  return {
    gasLimit,
    gasPrice: BigInt(gasPrice),
    bufferedGasPrice,
    requiredBalance,
    topUpWei: currentBalance < requiredBalance ? requiredBalance - currentBalance : 0n,
  };
}

async function estimateTransactionFunding(address, { to, data, value = 0n }, label) {
  const [balance, estimatedGas, gasPrice] = await Promise.all([
    nativeBalance(address),
    withArcRpcRetry(
      () => publicClient.estimateGas({ account: address, to, data, value }),
      { label: `${label} gas estimate` },
    ),
    withArcRpcRetry(
      () => publicClient.getGasPrice(),
      { label: `${label} gas price` },
    ),
  ]);
  return {
    balance,
    estimatedGas,
    ...calculateGasFundingPlan({ balance, estimatedGas, gasPrice, value }),
  };
}

async function assertSponsorCanTopUp(recipient, topUpWei, label) {
  const [sponsorBalance, transferGas, gasPrice] = await Promise.all([
    nativeBalance(SELLER_ADDRESS),
    withArcRpcRetry(
      () => publicClient.estimateGas({
        account: SELLER_ADDRESS,
        to: recipient,
        value: topUpWei,
      }),
      { label: `${label} sponsor transfer gas estimate` },
    ),
    withArcRpcRetry(
      () => publicClient.getGasPrice(),
      { label: `${label} sponsor transfer gas price` },
    ),
  ]);
  const sponsorRequired = topUpWei + (
    buffered(transferGas, GAS_LIMIT_BUFFER_BPS)
    * buffered(gasPrice, GAS_PRICE_BUFFER_BPS)
  );
  if (sponsorBalance < sponsorRequired) {
    const error = new Error(
      `BARD gas sponsor is underfunded for ${label}. Retry after the platform gas wallet is funded.`,
    );
    error.code = 'GAS_SPONSOR_UNDERFUNDED';
    error.status = 503;
    error.requiredWei = sponsorRequired.toString();
    error.balanceWei = sponsorBalance.toString();
    throw error;
  }
}

/**
 * Estimate one exact transaction and make sure its signer can pay the buffered fee.
 * Arc exposes native USDC with 18-decimal RPC units, while its ERC-20 interface uses
 * 6 decimals, so all values in this helper are native wei.
 */
export async function ensureGasForTransaction(address, tx, { label = 'transaction' } = {}) {
  const plan = await estimateTransactionFunding(address, tx, label);
  if (plan.topUpWei === 0n) return { ...plan, funded: false };
  if (!SELLER_ADDRESS) {
    throw Object.assign(
      new Error('BARD gas sponsor is not configured'),
      { code: 'GAS_SPONSOR_NOT_CONFIGURED', status: 503 },
    );
  }
  if (address.toLowerCase() === SELLER_ADDRESS.toLowerCase()) {
    throw Object.assign(
      new Error(`BARD platform wallet lacks enough native USDC for ${label}`),
      {
        code: 'GAS_SPONSOR_UNDERFUNDED',
        status: 503,
        requiredWei: plan.requiredBalance.toString(),
        balanceWei: plan.balance.toString(),
      },
    );
  }

  return withWalletQueue(SELLER_ADDRESS, async () => {
    const refreshed = await estimateTransactionFunding(address, tx, label);
    if (refreshed.topUpWei === 0n) return { ...refreshed, funded: false };
    await assertSponsorCanTopUp(address, refreshed.topUpWei, label);

    const wc = await signerFor(SELLER_ADDRESS);
    const txHash = await wc.sendTransaction({ to: address, value: refreshed.topUpWei });
    try {
      await waitForReceipt(txHash, `gas top-up for ${address}`);
    } catch (error) {
      const balance = await nativeBalance(address).catch(() => 0n);
      if (balance < refreshed.requiredBalance) {
        error.gasTopUpTxHash = error.txHash || txHash;
        delete error.txHash;
        throw error;
      }
    }

    const balance = await nativeBalance(address);
    if (balance < refreshed.requiredBalance) {
      const error = new Error(
        `Gas top-up for ${label} confirmed, but the managed wallet is still underfunded`,
      );
      error.code = 'GAS_TOP_UP_INSUFFICIENT';
      error.status = 502;
      error.gasTopUpTxHash = txHash;
      error.requiredWei = refreshed.requiredBalance.toString();
      error.balanceWei = balance.toString();
      throw error;
    }
    return { ...refreshed, funded: true, txHash, balance };
  });
}

/**
 * Ensure `address` holds at least `minNativeWei` native (gas) USDC, topping up from
 * the platform wallet if short. Arc pays gas in native USDC.
 */
export async function ensureGas(address, minNativeWei = 2_000_000_000_000_000n, topUpWei = 5_000_000_000_000_000n) {
  const bal = await nativeBalance(address);
  if (bal >= minNativeWei) return { funded: false, balance: bal };
  if (!SELLER_ADDRESS) throw new Error('ensureGas: SELLER_ADDRESS not set for gas top-up');
  const wc = await signerFor(SELLER_ADDRESS);
  const txHash = await wc.sendTransaction({ to: address, value: topUpWei });
  await waitForReceipt(txHash, `gas top-up for ${address}`);
  return { funded: true, txHash, balance: await nativeBalance(address) };
}

// ──────────────────────────────────────────────
//  jobId extraction from a createJob receipt
// ──────────────────────────────────────────────

// JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, ...)
async function jobIdFromReceipt(receipt) {
  const { decodeEventLog } = await import('viem');
  const eventAbi = [{
    type: 'event', name: 'JobCreated',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'evaluator', type: 'address' },
      { indexed: false, name: 'expiredAt', type: 'uint48' },
      { indexed: false, name: 'hook', type: 'address' },
    ],
  }];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== AGENTIC_COMMERCE_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = decodeEventLog({ abi: eventAbi, data: log.data, topics: log.topics });
      if (parsed.eventName === 'JobCreated') return BigInt(parsed.args.jobId);
    } catch { /* not this event */ }
  }
  throw new Error('escrow-service: JobCreated not found in createJob receipt');
}

// ──────────────────────────────────────────────
//  Lifecycle
// ──────────────────────────────────────────────

/**
 * Open a job, configure BARD policy, assign the provider, set budget, deposit the
 * platform fee, and fund the escrow — the full "money in" flow for an agent↔agent
 * bounty. Returns the on-chain jobId and every tx hash.
 *
 * @param {object} p
 * @param {string} p.creatorWallet   creator agent Turnkey wallet (client)
 * @param {string} p.providerWallet  provider agent Turnkey wallet
 * @param {bigint} [p.providerAgentId]
 * @param {string} [p.evaluator]     defaults to the platform wallet
 * @param {number} p.earningsUsdc    agent earnings (budget)
 * @param {number} [p.platformFeeUsdc]  platform fee (0 = no fee)
 * @param {string} [p.feeRecipient]  fee recipient (defaults to platform wallet)
 * @param {number} [p.maxFeeBps]     consented fee cap (0 = uncapped)
 * @param {number} [p.minRepScore]
 * @param {number} [p.expirySeconds] seconds until expiry (default 72h)
 * @param {string} [p.description]
 */
export async function openAndFund(p) {
  const evaluator = p.evaluator || SELLER_ADDRESS;
  const feeRecipient = p.feeRecipient || SELLER_ADDRESS;
  const earningsWei = toUsdcWei(p.earningsUsdc);
  const feeWei = toUsdcWei(p.platformFeeUsdc || 0);
  const expiredAt = Math.floor(Date.now() / 1000) + (p.expirySeconds || 72 * 3600);
  const txs = {};

  let jobId;
  try {
    // 1. createJob (creator). Provider assigned via setProvider below (first-come style).
    {
      const cd = buildCreateJobCalldata({
        provider: '0x0000000000000000000000000000000000000000',
        evaluator,
        expiredAt,
        description: p.description || 'BARD bounty',
        providerAgentId: 0n,
      });
      const r = await sendAs(p.creatorWallet, cd, 'createJob');
      txs.createJob = r.txHash;
      jobId = await jobIdFromReceipt(r.receipt);
    }

    // 2. configureBardJob (creator).
    {
      const cd = buildConfigureBardJobCalldata({
        jobId, platformFee: feeWei, feeRecipient,
        maxFeeBps: p.maxFeeBps || 0, minRepScore: p.minRepScore || 0,
      });
      txs.configure = (await sendAs(p.creatorWallet, cd, 'configureBardJob')).txHash;
    }

    // 3. setProvider (creator).
    {
      const cd = buildSetProviderCalldata({ jobId, provider: p.providerWallet, agentId: p.providerAgentId || 0n });
      txs.setProvider = (await sendAs(p.creatorWallet, cd, 'setProvider')).txHash;
    }

    // 4. setBudget (provider).
    {
      const cd = buildSetBudgetCalldata({ jobId, amount: earningsWei });
      txs.setBudget = (await sendAs(p.providerWallet, cd, 'setBudget')).txHash;
    }

    // 5. depositFee (creator): approve hook then deposit.
    if (feeWei > 0n) {
      const approve = buildApproveCalldata({ spender: BARD_JOB_HOOK_ADDRESS, amount: feeWei });
      txs.approveFee = (await sendAs(p.creatorWallet, approve, 'approve(hook,fee)')).txHash;
      const deposit = buildDepositFeeCalldata({ jobId });
      txs.depositFee = (await sendAs(p.creatorWallet, deposit, 'depositFee')).txHash;
    }

    // 6. fund (creator): approve AgenticCommerce then fund.
    {
      const approve = buildApproveCalldata({ spender: AGENTIC_COMMERCE_ADDRESS, amount: earningsWei });
      txs.approveBudget = (await sendAs(p.creatorWallet, approve, 'approve(ac,budget)')).txHash;
      const fund = buildFundCalldata({ jobId, expectedBudget: earningsWei });
      txs.fund = (await sendAs(p.creatorWallet, fund, 'fund')).txHash;
    }

    return { jobId, txs };
  } catch (error) {
    error.jobId = jobId?.toString() || null;
    error.completedTransactions = { ...txs };
    throw error;
  }
}

/**
 * Resume a partially configured ERC-8183 job without creating a replacement job.
 * Every completed leg is detected from chain state before the missing legs run.
 */
export async function resumeAndFund(p) {
  const jobId = BigInt(p.jobId);
  const earningsWei = toUsdcWei(p.earningsUsdc);
  const feeWei = toUsdcWei(p.platformFeeUsdc || 0);
  const evaluator = p.evaluator || SELLER_ADDRESS;
  const feeRecipient = p.feeRecipient || SELLER_ADDRESS;
  const zeroAddress = '0x0000000000000000000000000000000000000000';
  const sameAddress = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const txs = {};

  try {
    let job = await getJob(jobId);
    if (!sameAddress(job.client, p.creatorWallet)) {
      throw new Error(`escrow-service: job ${jobId} belongs to a different creator`);
    }
    if (!sameAddress(job.evaluator, evaluator)) {
      throw new Error(`escrow-service: job ${jobId} has a different evaluator`);
    }
    if (!sameAddress(job.hook, BARD_JOB_HOOK_ADDRESS)) {
      throw new Error(`escrow-service: job ${jobId} uses a different hook`);
    }
    if (![0, 1].includes(Number(job.status))) {
      throw new Error(`escrow-service: job ${jobId} cannot resume from status ${Number(job.status)}`);
    }

    const feeMeta = await getFeeMeta(jobId);
    if (feeMeta.configured) {
      if (
        BigInt(feeMeta.platformFee) !== feeWei ||
        !sameAddress(feeMeta.feeRecipient, feeRecipient)
      ) {
        throw new Error(`escrow-service: job ${jobId} fee configuration does not match the bounty`);
      }
    } else {
      const cd = buildConfigureBardJobCalldata({
        jobId,
        platformFee: feeWei,
        feeRecipient,
        maxFeeBps: p.maxFeeBps || 0,
        minRepScore: p.minRepScore || 0,
      });
      txs.configure = (await sendAs(p.creatorWallet, cd, 'configureBardJob(resume)')).txHash;
    }

    if (sameAddress(job.provider, zeroAddress)) {
      const cd = buildSetProviderCalldata({
        jobId,
        provider: p.providerWallet,
        agentId: p.providerAgentId || 0n,
      });
      txs.setProvider = (await sendAs(p.creatorWallet, cd, 'setProvider(resume)')).txHash;
    } else if (!sameAddress(job.provider, p.providerWallet)) {
      throw new Error(`escrow-service: job ${jobId} is assigned to a different provider`);
    }

    job = await getJob(jobId);
    if (BigInt(job.budget) === 0n) {
      const cd = buildSetBudgetCalldata({ jobId, amount: earningsWei });
      txs.setBudget = (await sendAs(p.providerWallet, cd, 'setBudget(resume)')).txHash;
    } else if (
      BigInt(job.budget) !== earningsWei ||
      !sameAddress(job.paymentToken, USDC_ADDRESS)
    ) {
      throw new Error(`escrow-service: job ${jobId} budget does not match the bounty`);
    }

    const refreshedFeeMeta = await getFeeMeta(jobId);
    if (feeWei > 0n && !refreshedFeeMeta.feeDeposited) {
      const approve = buildApproveCalldata({
        spender: BARD_JOB_HOOK_ADDRESS,
        amount: feeWei,
      });
      txs.approveFee = (
        await sendAs(p.creatorWallet, approve, 'approve(hook,fee,resume)')
      ).txHash;
      const deposit = buildDepositFeeCalldata({ jobId });
      txs.depositFee = (
        await sendAs(p.creatorWallet, deposit, 'depositFee(resume)')
      ).txHash;
    }

    job = await getJob(jobId);
    if (Number(job.status) === 0) {
      const approve = buildApproveCalldata({
        spender: AGENTIC_COMMERCE_ADDRESS,
        amount: earningsWei,
      });
      txs.approveBudget = (
        await sendAs(p.creatorWallet, approve, 'approve(ac,budget,resume)')
      ).txHash;
      const fund = buildFundCalldata({ jobId, expectedBudget: earningsWei });
      txs.fund = (await sendAs(p.creatorWallet, fund, 'fund(resume)')).txHash;
    } else if (p.fundTxHash) {
      txs.fund = p.fundTxHash;
    } else {
      throw new Error(
        `escrow-service: job ${jobId} is already funded; retry with its original funding transaction hash`,
      );
    }

    return { jobId, txs };
  } catch (error) {
    error.jobId = jobId.toString();
    error.completedTransactions = { ...txs };
    throw error;
  }
}

/** Provider submits a deliverable (Funded -> Submitted). */
export async function submit({ providerWallet, jobId, deliverableLabel = 'deliverable' }) {
  const cd = buildSubmitCalldata({ jobId, deliverable: hashTag(deliverableLabel) });
  const { txHash } = await sendAs(providerWallet, cd, 'submit');
  return { txHash };
}

/** Evaluator (platform) approves -> releases earnings to provider + fee to recipient. */
export async function release({ jobId, reasonLabel = 'approved', evaluator = SELLER_ADDRESS }) {
  const cd = buildCompleteCalldata({ jobId, reason: hashTag(reasonLabel) });
  const { txHash, receipt } = await sendAs(evaluator, cd, 'complete');
  return { txHash, receipt };
}

/**
 * Decode the settled amounts from a `complete` receipt (gas-independent proof):
 *   { paidToProvider, provider, feePaid, feeRecipient } — USDC (human units).
 */
export async function decodeSettlement(receipt) {
  const { decodeEventLog } = await import('viem');
  const acEvents = [{
    type: 'event', name: 'PaymentReleased',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  }];
  const hookEvents = [{
    type: 'event', name: 'BardFeeReleased',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: true, name: 'feeRecipient', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint128' },
    ],
  }];
  const out = { paidToProvider: 0, provider: null, feePaid: 0, feeRecipient: null };
  for (const log of receipt.logs) {
    const addr = log.address.toLowerCase();
    if (addr === AGENTIC_COMMERCE_ADDRESS.toLowerCase()) {
      try {
        const p = decodeEventLog({ abi: acEvents, data: log.data, topics: log.topics });
        if (p.eventName === 'PaymentReleased') { out.paidToProvider = fromUsdcWei(p.args.amount); out.provider = p.args.provider; }
      } catch { /* other event */ }
    } else if (addr === BARD_JOB_HOOK_ADDRESS.toLowerCase()) {
      try {
        const p = decodeEventLog({ abi: hookEvents, data: log.data, topics: log.topics });
        if (p.eventName === 'BardFeeReleased') { out.feePaid = fromUsdcWei(p.args.amount); out.feeRecipient = p.args.feeRecipient; }
      } catch { /* other event */ }
    }
  }
  return out;
}

/** Evaluator (platform) rejects -> refunds earnings + fee to the client. */
export async function reject({ jobId, reasonLabel = 'rejected', evaluator = SELLER_ADDRESS }) {
  const cd = buildRejectCalldata({ jobId, reason: hashTag(reasonLabel) });
  const { txHash } = await sendAs(evaluator, cd, 'reject');
  return { txHash };
}

/** Anyone refunds an expired job: claimRefund (earnings) + refundFee (fee). */
export async function refundExpired({ jobId, caller = SELLER_ADDRESS }) {
  const txs = {};
  txs.claimRefund = (await sendAs(caller, buildClaimRefundCalldata({ jobId }), 'claimRefund')).txHash;
  // refundFee only matters if a fee was deposited; ignore its revert if none.
  try {
    txs.refundFee = (await sendAs(caller, buildRefundFeeCalldata({ jobId }), 'refundFee')).txHash;
  } catch (e) {
    txs.refundFee = null;
  }
  return { txs };
}

export { AGENTIC_COMMERCE_ADDRESS, BARD_JOB_HOOK_ADDRESS, SELLER_ADDRESS };
