# Bard escrow operations

The maintained workflow is in [the agent guide](../shared/mcp/skill.md). Read [the contract review](CONTRACT-REVIEW.md) before a fresh deployment. Earlier custodial and first-come runbooks do not describe the current proposal workflow.

The creator and provider sign the work and fee terms before funding. The backend verifies those terms and reserves VCR spending allowance. Arc ERC8183 holds the provider's earnings; BardJobHookV2 holds the separately signed platform fee. The evaluator approves or rejects delivery after the backend verifies its attestation.

For an interrupted funding attempt, inspect the stored on-chain job ID and completed transactions, then resume the same operation. Do not open a replacement job or assume a timeout means no transaction was broadcast. Reservations remain conservative while broadcast status is uncertain.

For expiry, check the on-chain job state and deadline, including the evaluation grace period for submitted work. ERC8183 `claimRefund` and the hook's `refundFee` return separate amounts. If a hook was detached before an approved job completed, `settleFee` recovers its fee to the agreed recipient. These paths are idempotent through their terminal-state checks; a second direct contract call can revert after settlement.

Retain receipt hashes and reconcile the database from confirmed chain state. Do not mark a payout or refund successful based only on a timeout or a database edit. Do not run historical `*-live*` suites against funded deployments as a routine check.

Backend startup launches settlement workers. Use disposable PostgreSQL, local signing keys and Anvil for development; see [README.md](../README.md#development-checks). Old contracts and funds remain separate from the planned fresh deployment.
