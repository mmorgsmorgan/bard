import { getOwnerAssurance, getUnavailableOwnerAssurance } from './ethos-service.js';

export function createPublicProfileEthosHandler({
  getProfile,
  getAssurance = getOwnerAssurance,
  getUnavailable = getUnavailableOwnerAssurance,
} = {}) {
  if (typeof getProfile !== 'function') {
    throw new TypeError('getProfile is required');
  }

  return async function publicProfileEthosHandler(req, res) {
    const profile = await getProfile(req.params.wallet);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const wallet = profile.wallet;
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    try {
      const ownerAssurance = await getAssurance(wallet);
      return res.json({ ownerAssurance });
    } catch {
      return res.status(502).json({
        error: 'Could not load Ethos owner assurance',
        ownerAssurance: getUnavailable(wallet),
      });
    }
  };
}
