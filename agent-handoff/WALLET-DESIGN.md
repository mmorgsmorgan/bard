# User-PC wallet proposal

Research checkpoint 2026-11-05. Not implemented.

## Feasibility and custody

A normal laptop can generate keys and sign transactions using an RPC endpoint. No full blockchain node or local LLM is required. A lightweight local signer can expose a narrow MCP/CLI interface to the user's agent.

Keys, shares and unlock secrets belong in a secure signer interface, outside model prompts and logs. Bard's existing local provider is backend-local. cli/setup-agent.mjs also supports a supplied PRIVATE_KEY, but that is not a protected local signing service.

## Separate identity from spending

The wallet controls funds. A separate per-installation key identifies an authorized agent runtime. Bard stores its public key, a wallet-signed binding, revocation state, scoped sessions and the optional Ethos human attestation.

Public challenge-response proofs establish the linkage without giving Bard a wallet key share. If Bard holds a threshold share, that gives it an additional co-signing role.

## Three-share scheme

The user's description matches 2-of-3 MPC/threshold signatures. One possible arrangement is user-device share, Bard share and user-controlled recovery share. Normal signing uses user-device plus Bard. User-controlled recovery can use the device/recovery combination or another explicitly designed replacement procedure. Bard alone cannot sign.

Use reviewed MPC infrastructure. Distributed key generation, nonce safety, peer authentication, share refresh and recovery need specialist implementation and review. Never implement this by slicing key strings or reconstructing the full secret in the AI process.

The AES salt, IV, tag and ciphertext in backend/wallet-provider.js are encryption fields, not independent MPC shares. The backend master key can decrypt the current wallet.

Bard co-signing makes normal operation depend on Bard availability. A two-user-share recovery path can bypass Bard co-signing policies. Limits that must survive recovery need account/contract enforcement.

## Local signing controls

The signer independently checks the chain, contract, recipient, amount, nonce, expiry, method and policy. Bind ACL terms and VCR policy to each prepared request. New approvals or policy changes need appropriate user authorization.

A same-user process with arbitrary OS access can still steal a software wallet or misuse an unlocked signer. Protect signing with OS isolation and hardware-backed storage where supported. Hiding keys from tool responses alone is insufficient.

## Device binding and privacy

Create a random per-installation key. Have the wallet sign a binding containing Bard's domain, agent ID, installation public key, permitted scopes, nonce and expiry. Require proof of possession on requests, support revocation, and constrain an installation credential to its enrolled agent identity.

Bard needs public proofs and minimal metadata. Avoid machine serials, MAC addresses, file inventories, prompts, browsing history and global hardware fingerprints.

For stronger copy resistance, use a device-bound non-exportable authentication key in TPM/Secure Enclave/security hardware where available. Authentication keys are separate from EVM spending keys. Synced passkeys can exist on multiple devices and do not prove one PC.

This proves an authorized installation, not a unique AI model. Software keys can be copied if exposed; compromised devices can misuse credentials. Absolute clone prevention is not a valid promise. Ethos verification also does not automatically guarantee one account per physical person.

## Proposed flow

1. Agent invokes local setup.
2. Secure local signer creates/protects the wallet or participates in reviewed MPC generation.
3. Create installation credentials and a wallet-signed agent binding.
4. Register public proofs with Bard.
5. Human signs a separate Ethos ownership challenge.
6. User grants scoped spending permissions.
7. Agent requests transactions through the policy-enforcing signer.
8. Bard verifies proofs and, if using MPC, co-signs under policy.
9. Provide revocation, device replacement and recovery while retaining agent reputation.

## Required implementation

Replace backend-only signing with prepare/sign/submit APIs. Bind every request to agent, wallet, exact payload, chain, nonce, policy, expiry and one-time operation ID. Validate signed transactions and confirmed receipts. Preserve idempotency through disconnects and partial escrow funding.

Update managed-only proposal, funding and signer call sites. Keep the platform evaluator's authority separate. Test with a mock local signer and adversarial requests before a live custody migration.

## Binance and Arc

Release decision on 2026-11-05: user requested Coming soon. All Bard Binance commands are disabled. Keep the implementation dormant until the user authorizes release.

Installed baw wallet chains returned NOT_LOGGED_IN. Official developer docs checked 2026-11-05 list BSC 56, Ethereum 1, Base 8453 and Solana CT_501. Arc mainnet and Arc Testnet 5042002 are absent.

Bundled skill examples include additional chains, so sources differ. Require a paired wallet to return the exact intended chain and support the needed contract calls before enabling it. EVM address compatibility alone is insufficient.

## Sources

Binance Agentic Wallet docs
https://developers.binance.com/en/docs/products/agentic-wallet/welcome

Binance FAQ
https://www.binance.com/en-IA/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763

Binance three-share explanation
https://www.binance.com/en/support/faq/detail/4efebcb9a937417ca31baa2f7754c50f

BitGo MPC/TSS and recovery
https://support.bitgo.com/support/solutions/articles/158000454652-mpc-tss-wallet-operations-overview

NIST authentication and backup eligibility
https://pages.nist.gov/800-63-4/sp800-63b.html

W3C WebAuthn
https://www.w3.org/TR/webauthn-3/
