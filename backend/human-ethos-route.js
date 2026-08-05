import { getOwnerAssurance, getUnavailableOwnerAssurance } from './ethos-service.js';

export function createHumanEthosHandler({
  getAssurance = getOwnerAssurance,
  getUnavailable = getUnavailableOwnerAssurance,
} = {}) {
  return async function humanEthosHandler(req, res) {
    const wallet = req.human.wallet_address;
    res.set('Cache-Control', 'private, max-age=60');
    try {
      const ownerAssurance = await getAssurance(wallet);
      res.json({ ownerAssurance });
    } catch {
      res.status(502).json({
        error: 'Could not load Ethos owner assurance',
        ownerAssurance: getUnavailable(wallet),
      });
    }
  };
}
