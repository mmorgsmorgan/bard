// Preload: retry global fetch on transient network drops (undici stale keep-alive
// sockets to Railway's edge throw "fetch failed" before the request is sent, so
// a retry opens a fresh socket). Only retries thrown network errors, never HTTP
// error statuses (those return a Response).
const orig = globalThis.fetch;
globalThis.fetch = async (...args) => {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try { return await orig(...args); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
};
