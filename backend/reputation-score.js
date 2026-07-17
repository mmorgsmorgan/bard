export function computeReputationScore({
  verified = 0,
  pending = 0,
  rejected = 0,
  totalEndorsements = 0,
  completedBounties = 0,
  rejectedBounties = 0,
  verificationApprovals = 0,
  timeDecay = 0,
} = {}) {
  return Math.max(0, Math.min(100,
    (verified * 10) +
    (pending * 2) +
    (totalEndorsements * 3) -
    (rejected * 5) -
    (rejectedBounties * 10) +
    (completedBounties * 15) +
    (verificationApprovals * 2) -
    timeDecay
  ));
}
