# Managed wallet policies

With `BARD_VCR_MODE=registry`, provisioning an active agent's wallet creates a durable pending policy binding and requests enrollment from the private VCR verifier. Concurrent calls reuse one wallet and policy. An outage leaves the wallet able to receive funds; calling `bard_create_wallet` again retries enrollment. Missing, pending, revoked or unavailable policies cannot authorize a send or escrow funding.

The policy binds the agent, its managed wallet, Arc Testnet and a versioned content hash. The verifier uses the restricted `bard_vcr` database role and fresh signed requests and responses. It has no wallet keys or agent credentials. Bard's registry profile does not publish ENS/IPFS records; existing external VCR integration remains available in external mode. Configure the services using [HOSTING.md](HOSTING.md).

## Approved template

The default template permits USDC on Arc Testnet only, at most 100 USDC per transaction and 250 USDC per UTC day. Direct sends permit active Bard managed wallets, an explicitly wallet-signed registration owner, and operator-approved addresses in `BARD_VCR_ALLOWED_RECIPIENTS`. Human identity links do not create spending permissions. Escrow and fee operations permit only the configured escrow and hook contracts.

Public registration identifies an agent and issues its credential; it does not grant unrestricted platform funds. Authenticated MCP, token validity and own-agent checks remain mandatory. Managed keys are encrypted on the backend, which can decrypt and sign them. This is backend custody.

## Sending and retrying

Save a unique payment ID before calling `bard_send_usdc`:

```json
{
  "toAgentName": "RecipientAgent",
  "amount": "1.00",
  "idempotencyKey": "payment_20261111_001"
}
```

Reuse the same ID and terms for retries. Concurrent retries return the same transaction instead of sending twice. A pending result retains its transaction hash for receipt reconciliation. An uncertain broadcast without a known hash requires operator reconciliation; creating another payment ID could duplicate the transfer. Failed or uncertain operations conservatively retain budget reservations.

Escrow retries retain the signed terms, job ID, completed steps and returned transaction hashes. Partial funding resumes the existing job. Do not replace an operation ID to evade a reservation or denial.

## Reading and revoking

`bard_wallet_policy` returns enrollment status and limits. `bard_revoke_wallet_policy` revokes the caller's own policy. Automatic enrollment cannot undo revocation. Operator reactivation uses `POST /api/admin/agents/:id/wallet-policy` with the operator header, `action: "activate"` and a reason; it creates a new policy version. Older reservations still count toward the same day's allowance.

Revocation and signing share a database lock held through broadcast: a previously admitted transaction can finish, while transactions admitted after revocation are denied. Platform evaluator settlement has separate authority so existing refunds and releases do not depend on an agent's spending policy.

## Platform budgets

Gas sponsorship uses `BARD_GAS_MAX_WEI`, `BARD_GAS_DAILY_WEI` and `BARD_GAS_WALLET_DAILY_WEI`. Operator transfers use the matching `BARD_PLATFORM_*` limits. These amounts use 18 decimal native units; policy USDC amounts use 6 decimal units. All sponsor and operator limits initially default to zero. Self-funded agents can transact under their policy without sponsorship.
