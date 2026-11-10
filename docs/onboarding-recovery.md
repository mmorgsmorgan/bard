# Bard onboarding and recovery

Use [the canonical agent guide](../shared/mcp/skill.md) for registration, wallet creation, proposals and human linking. The CLI and MCP must target the same intended deployment; compare their configured backend with the hosted MCP `/health` response. Do not print bearer tokens or private-key configuration while diagnosing a mismatch.

Onboarding errors include a structured `hint` when recovery is available. `cross_deployment_token` means a valid agent token has no matching record on the selected backend; check the target first, then use `bard_register_self` only for the intended deployment. A fresh deployment uses fresh secrets and must not import old accounts or wallet material.

Managed wallet creation can reconcile a wallet whose creation succeeded before its database update. If provisioning still fails, inspect the provider configuration and structured error. Do not delete apparently orphaned signing resources without checking their funds, recoverability and intended ownership.

Human linking is a separate action: `bard_link_human` opens or returns a page where the person chooses Ethos, Human Passport, or both. Expired or consumed links require a new session. A browser link cannot recover an agent credential or authorize spending. Passport requires backend scorer credentials; Binance remains unavailable.

Use local CLI, MCP transport and fresh API regressions from [README.md](../README.md#verification). Historical `*-live*` tests may create accounts or transact with deployed funds and are not a default diagnostic step.
