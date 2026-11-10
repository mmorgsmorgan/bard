# Bard contract review — 2026-11-09

The fresh settlement stack is `ERC8183` behind an ERC1967 proxy, plus `BardJobHookV2`. Deploy it with `contracts/script/DeployEscrowSecure.s.sol`. This review covers the local source and tests; it does not certify a deployment or the security of operator keys.

## Previously exposed admin

The address originally supplied for the new admin, `0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8`, is the same test wallet identified in [the earlier security audit](../SECURITY-AUDIT-escrow.md). That audit records its private key as permanently exposed in Git history. A checksum-valid address is not evidence of secure custody.

The deployment script now rejects this address before broadcasting. Use a fresh securely controlled wallet or multisig for both the intended admin and fee recipient. At the time of this review, no replacement was chosen and no deployment or old-fund movement occurred.

2026-11-10 update: the user supplied and configured a replacement signer. The fresh implementation, proxy and hook are now deployed and source-verified on Arc Testnet. Five successful receipts match the reviewed simulation. Live checks confirm the selected wallet holds both admin roles, hook ownership and treasury; the exposed wallet has neither admin role. Proxy linkage, allowlists, zero core fees, token/reader configuration and runtime code were also checked. See [the deployment record](../agent-handoff/DEPLOYMENT-2026-11-10.md) for addresses, receipts and source verification. The exposed-address guard remains in place. Successful local signing does not independently establish secure custody.

## Changes completed

- Fixed deployment role handoff: a distinct bootstrap signer gives up both roles; a signer that is also the final admin keeps them. Read the actual broadcast signer with `vm.readCallers()` and verify final ownership, roles, treasury, allowlists and initially zero core fees.
- Added regressions for distinct/same admin, zero admin and the exposed test address.
- Removed the old `BardJobHook` implementation and `DeployEscrow.s.sol`. Moved its lifecycle and edge-case tests onto V2, so those tests now exercise the implementation being deployed.
- Removed unused `BardProfile`, `BardBadge`, `BardPFP`, `BardProof`, `BardAgent`, `BardRecordBoard` and the legacy `Deploy.s.sol`; no active service consumed them. Vouching and `BardVouch` were already removed in this cleanup. The unused RecordBoard also had a direct-record signature without chain/contract domain binding that did not cover the endorsers array; it must not be resurrected unchanged.
- Removed an unused callback selector. Kept separate fee refund and settlement recovery methods: expiry does not invoke a hook, and an administrator can detach a hook before completion, so those methods serve distinct recovery cases.

Safety copies of removed sources and modified tests are under `/tmp/bard-resume-20261109-contract-cleanup/`. Git preserves tracked source history. Existing deployed contracts are unaffected by local source removal.

## Remaining authority and design limits

| Finding | Implication and required handling |
| --- | --- |
| The proxy admin can upgrade; the operator can pause, withdraw escrow while paused and detach hooks. | The system retains trusted administration. Use secure governance and review these powers before handling real value. A user-PC wallet alone does not remove this trust. |
| `ERC8183.complete` reads current global platform/evaluator fee rates. | Raising those rates after agreement would reduce the provider's signed earnings, in addition to Bard's separate signed fee. Fresh deployment verifies both rates start at zero. Keep them zero; per-job fee snapshots or permanent rate restrictions are needed if that governance assumption changes. |
| ACL signatures and VCR policies are checked in the backend. ERC8183 stores the task hash/deadline and relies on its evaluator. | The contracts do not independently establish work quality, verify ACL signatures, or enforce VCR. Direct core jobs are not automatically Bard-verified jobs. Additional contract enforcement would be a separate design change. |
| The core permits jobs without hooks. V2's reputation gate is optional when its reader or agent ID is zero. | Bard's agent reputation eligibility remains a backend rule in the current deployment. Do not claim mandatory on-chain reputation enforcement. |
| V2 holds one configured payment token and assumes normal transfer behavior. | Fresh configuration must use the intended Arc USDC interface and corresponding chain. Supporting other or fee-on-transfer tokens requires additional accounting checks. |
| V2 uses single-step owner transfer and permits a zero constructor owner to fall back to the deployer. | The fresh deployment passes and verifies a nonzero explicit owner. A future ownership rotation would benefit from a two-step acceptance process. |

## Validation

`forge test --root contracts`: **60 passed**, including 256 fee-cap fuzz cases. All hook lifecycle and edge tests now run against V2. The compiler reports one existing suggestion to mark `beforeAction` as `view`.

The API integration suite on disposable PostgreSQL and Anvil also passed signed proposal creation/update/acceptance, fee terms surviving server configuration changes, interrupted funding resuming on the same job without a second fee deposit, VCR denial before broadcast, evidence/revision tampering rejection and a single provider/fee payout despite repeated approval.

This is a source review with regression tests. It does not verify live wallet custody or authorize a deployment. Independent review of the financial and governance assumptions remains necessary before a production release.
