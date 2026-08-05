import 'dotenv/config';

const ETHOS_API_BASE = (process.env.ETHOS_API_BASE || 'https://api.ethos.network/api/v2').replace(/\/$/, '');
const ETHOS_CLIENT_NAME = process.env.ETHOS_CLIENT_NAME || 'bard';
const ETHOS_TIMEOUT_MS = Math.max(500, Number.parseInt(process.env.ETHOS_TIMEOUT_MS || '4000', 10) || 4000);
const ETHOS_CACHE_TTL_MS = Math.max(10_000, Number.parseInt(process.env.ETHOS_CACHE_TTL_MS || '300000', 10) || 300000);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const cache = new Map();
const inFlight = new Map();

function emptyAssurance(ownerWallet = null, relationship = 'independent', reason = 'no_owner') {
  return {
    source: 'ethos',
    available: false,
    relationship,
    ownerWallet,
    humanVerificationStatus: null,
    humanVerified: false,
    score: null,
    level: null,
    profile: null,
    reviews: { positive: 0, neutral: 0, negative: 0 },
    vouchesReceived: 0,
    checkedAt: null,
    reason,
  };
}

function validAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reviewCounts(user) {
  const received = user?.stats?.review?.received || {};
  return {
    positive: Number(received.positive || 0),
    neutral: Number(received.neutral || 0),
    negative: Number(received.negative || 0),
  };
}

function vouchCount(user) {
  const receivedCount = Number(user?.stats?.vouch?.received?.count);
  if (Number.isFinite(receivedCount)) return receivedCount;
  const totals = user?.stats?.vouchTotals;
  if (Array.isArray(totals)) {
    return totals.reduce((sum, item) => {
      const count = Number(item?.count?.received ?? item?.count ?? item?.total ?? 0);
      return sum + (Number.isFinite(count) ? count : 0);
    }, 0);
  }
  return Number(user?.stats?.vouches?.received || user?.stats?.vouchCount || 0) || 0;
}

function normalize(address, user, scoreResult, checkedAt) {
  const humanVerificationStatus = user?.humanVerificationStatus || null;
  const humanVerified = humanVerificationStatus === 'VERIFIED';
  const score = numberOrNull(scoreResult?.score ?? user?.score);
  return {
    source: 'ethos',
    available: Boolean(user || scoreResult),
    relationship: humanVerified ? 'verified_owner' : 'owner_linked',
    ownerWallet: address,
    humanVerificationStatus,
    humanVerified,
    score,
    level: scoreResult?.level || null,
    profile: user ? {
      displayName: user.displayName || null,
      username: user.username || null,
      avatarUrl: user.avatarUrl || user.avatar || null,
      url: user.links?.profile || null,
    } : null,
    reviews: reviewCounts(user),
    vouchesReceived: vouchCount(user),
    checkedAt,
    reason: null,
  };
}

async function fetchJson(path, fetchImpl, signal) {
  const response = await fetchImpl(`${ETHOS_API_BASE}${path}`, {
    headers: { Accept: 'application/json', 'X-Ethos-Client': ETHOS_CLIENT_NAME },
    signal,
  });
  if (!response.ok) throw new Error(`Ethos returned HTTP ${response.status}`);
  return response.json();
}

export async function getOwnerAssurance(ownerWallet, { fetchImpl = globalThis.fetch, independent = false, force = false } = {}) {
  const normalizedAddress = typeof ownerWallet === 'string' ? ownerWallet.toLowerCase() : null;
  if (independent || !validAddress(normalizedAddress) || normalizedAddress === ZERO_ADDRESS) {
    return emptyAssurance(validAddress(normalizedAddress) ? normalizedAddress : null, 'independent', independent ? 'platform_owned' : 'invalid_owner');
  }

  const now = Date.now();
  const cached = cache.get(normalizedAddress);
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (!force && inFlight.has(normalizedAddress)) return inFlight.get(normalizedAddress);

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ETHOS_TIMEOUT_MS);
    const checkedAt = new Date().toISOString();
    try {
      const [userResult, scoreResult] = await Promise.allSettled([
        fetchJson(`/user/by/address/${normalizedAddress}`, fetchImpl, controller.signal),
        fetchJson(`/score/address?address=${encodeURIComponent(normalizedAddress)}`, fetchImpl, controller.signal),
      ]);
      const user = userResult.status === 'fulfilled' ? userResult.value : null;
      const score = scoreResult.status === 'fulfilled' ? scoreResult.value : null;
      const value = user || score
        ? normalize(normalizedAddress, user, score, checkedAt)
        : { ...emptyAssurance(normalizedAddress, 'owner_linked', 'ethos_unavailable'), checkedAt };
      cache.set(normalizedAddress, { value, expiresAt: now + ETHOS_CACHE_TTL_MS });
      return value;
    } catch (error) {
      const value = { ...emptyAssurance(normalizedAddress, 'owner_linked', 'ethos_unavailable'), checkedAt };
      cache.set(normalizedAddress, { value, expiresAt: now + Math.min(ETHOS_CACHE_TTL_MS, 30_000) });
      return value;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(normalizedAddress);
    }
  })();
  inFlight.set(normalizedAddress, request);
  return request;
}

export function getUnavailableOwnerAssurance(ownerWallet, { independent = false, reason = 'ethos_pending' } = {}) {
  const normalizedAddress = typeof ownerWallet === 'string' ? ownerWallet.toLowerCase() : null;
  if (independent || !validAddress(normalizedAddress) || normalizedAddress === ZERO_ADDRESS) {
    return emptyAssurance(validAddress(normalizedAddress) ? normalizedAddress : null, 'independent', independent ? 'platform_owned' : 'invalid_owner');
  }
  return emptyAssurance(normalizedAddress, 'owner_linked', reason);
}

export function clearOwnerAssuranceCache() {
  cache.clear();
}
