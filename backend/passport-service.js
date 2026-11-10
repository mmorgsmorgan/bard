// Human Passport Stamps API v2. Only the server sees the API key or raw stamps.
// https://docs.passport.human.tech/building-with-passport/stamps/passport-api/api-reference
export function passportConfigured(env = process.env) {
  return Boolean(env.PASSPORT_API_KEY && /^\d+$/.test(env.PASSPORT_SCORER_ID || ''));
}

export async function getPassportAssurance(address, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const result = { source: 'passport', available: false, passed: false, score: null, threshold: null, expiresAt: null, checkedAt: new Date(now).toISOString() };
  if (!passportConfigured(env)) return { ...result, reason: 'passport_not_configured' };
  if (!/^0x[0-9a-f]{40}$/i.test(address || '') || /^0x0+$/i.test(address)) return { ...result, reason: 'invalid_wallet' };
  try {
    const base = new URL(env.PASSPORT_API_BASE || 'https://api.passport.xyz');
    if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) return { ...result, reason: 'passport_invalid_config' };
    const response = await fetchImpl(`${base.origin}/v2/stamps/${encodeURIComponent(env.PASSPORT_SCORER_ID)}/score/${encodeURIComponent(address.toLowerCase())}`, {
      headers: { Accept: 'application/json', 'X-API-KEY': env.PASSPORT_API_KEY }, signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    if (!response.ok) return { ...result, reason: 'passport_unavailable' };
    const data = await response.json();
    const score = typeof data.score === 'string' && data.score.trim() ? Number(data.score) : NaN;
    const threshold = typeof data.threshold === 'string' && data.threshold.trim() ? Number(data.threshold) : NaN;
    const expires = Date.parse(data.expiration_timestamp);
    const scored = Date.parse(data.last_score_timestamp);
    if (data.error || data.address?.toLowerCase() !== address.toLowerCase() || !Number.isFinite(score) || score < 0 || !Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(expires) || !Number.isFinite(scored) || scored > now + 60_000 || expires <= scored || typeof data.passing_score !== 'boolean') {
      return { ...result, reason: 'passport_invalid_response' };
    }
    const passed = data.passing_score === true && score >= threshold && expires > now;
    return { ...result, available: true, passed, score, threshold, scorerId: env.PASSPORT_SCORER_ID, expiresAt: new Date(expires).toISOString(), reason: passed ? null : expires <= now ? 'passport_expired' : 'passport_threshold_not_met' };
  } catch { return { ...result, reason: 'passport_unavailable' }; }
}
