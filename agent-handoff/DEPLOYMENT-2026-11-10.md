# Bard Arc Testnet deployment — 2026-11-10

The fresh ERC8183 implementation, ERC1967 proxy and BardJobHookV2 are deployed on Arc Testnet (chain `5042002`). All five transactions succeeded and match the reviewed simulation. The explorer confirms source verification for all three contracts.

| Contract | Address |
| --- | --- |
| ERC8183 implementation | [0x7DAE3eD8e9d99E95E20e11634EAE5d3Ba073D18D](https://explorer.testnet.arc.io/address/0x7DAE3eD8e9d99E95E20e11634EAE5d3Ba073D18D) |
| ERC8183 proxy (application escrow) | [0x680e73Ff53981629b8B814cE9A69AD1347867606](https://explorer.testnet.arc.io/address/0x680e73Ff53981629b8B814cE9A69AD1347867606) |
| BardJobHookV2 | [0x097eF956B18E20A8E9b509791c2a430b2750f32b](https://explorer.testnet.arc.io/address/0x097eF956B18E20A8E9b509791c2a430b2750f32b) |

Deployer, default admin, operator admin, hook owner and treasury: `0xB804d506d5446b1A3BeBEfC903D84F754973C2D2`.

Actual gas cost: **0.11481755625 testnet USDC**. Balance after deployment: `43.467972893466185482` testnet USDC. Native gas accounting uses 18 decimals; the Arc USDC ERC-20 interface uses 6 decimals. Forge's generic `ETH` label in the simulation refers to native testnet USDC here.

Broadcast completed at `2026-11-09T23:39:14.212Z` (November 10 in Africa/Lagos). Transactions used nonces 119–123.

## Verified configuration

- The proxy's EIP-1967 implementation slot points to the implementation above.
- Both admin roles, hook ownership and treasury belong to the selected wallet.
- The previously exposed wallet has neither admin role.
- Arc USDC `0x3600000000000000000000000000000000000000` is allowed and the hook is whitelisted.
- The hook points to the correct proxy and payment token. The optional reputation reader is zero; reputation eligibility remains enforced in the backend.
- Both global core fee rates are zero, and the proxy is unpaused. Keep the global core fees zero to preserve signed provider earnings.
- Runtime code is present for all three contracts, and every recorded receipt has successful status.

The source build uses Solidity 0.8.28, Cancun, optimizer 200 runs and via-IR. Source verification was confirmed using the explorer's address API, including the proxy's own source verification and implementation linkage.

## Transactions

| Nonce | Action | Transaction | Block |
| --- | --- | --- | --- |
| 119 | Deploy ERC8183 implementation | [0x7b533450926054ade1a99edb0947bc22820e4ef21c6dd2c77a8f46f3d3de3739](https://explorer.testnet.arc.io/tx/0x7b533450926054ade1a99edb0947bc22820e4ef21c6dd2c77a8f46f3d3de3739) | 71616767 |
| 120 | Deploy and initialize ERC1967 proxy | [0xa54eb9b7dc87d995d29eaae380df3d7577a7f52cd7b57456e28bc8c1f2fe5b52](https://explorer.testnet.arc.io/tx/0xa54eb9b7dc87d995d29eaae380df3d7577a7f52cd7b57456e28bc8c1f2fe5b52) | 71616772 |
| 121 | Deploy BardJobHookV2 | [0x183f738185ce24e45aa4d9eb20d7c759591b814cf633762d88c7b99a4941c22a](https://explorer.testnet.arc.io/tx/0x183f738185ce24e45aa4d9eb20d7c759591b814cf633762d88c7b99a4941c22a) | 71616777 |
| 122 | Allow Arc USDC | [0x7b8f79418133d5bbb1c05aa424ba15559e59e4465b4207f1c6981e4b9f82a1c9](https://explorer.testnet.arc.io/tx/0x7b8f79418133d5bbb1c05aa424ba15559e59e4465b4207f1c6981e4b9f82a1c9) | 71616779 |
| 123 | Allow BardJobHookV2 | [0x1e8ca31cccf472707c83e1fbfa79905c97bfd381ab15154afa47cb0b65e41fea](https://explorer.testnet.arc.io/tx/0x1e8ca31cccf472707c83e1fbfa79905c97bfd381ab15154afa47cb0b65e41fea) | 71616784 |

## Application configuration

Use these public values when configuring the fresh backend:

```dotenv
AGENTIC_COMMERCE_ADDRESS=0x680e73Ff53981629b8B814cE9A69AD1347867606
BARD_JOB_HOOK_ADDRESS=0x097eF956B18E20A8E9b509791c2a430b2750f32b
```

The fresh database and application services were rolled out on November 11, 2026. Public URLs, the funded managed evaluator, private policy verifier and successful hosted testnet settlement are recorded in [HOSTING-2026-11-11.md](HOSTING-2026-11-11.md). No old jobs, accounts or signing material were imported.

Machine-readable receipt, configuration and verification evidence is in [the deployment manifest](../contracts/deployments/arc-testnet-2026-11-10.json). The contracts are already deployed; continuing the application rollout does not require redeploying them.
