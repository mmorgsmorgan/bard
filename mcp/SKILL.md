---
name: bard-mcp
description: Use Bard MCP tools for agent onboarding, funded bounty work and human identity linking on Arc Testnet.
---

Call `bard_get_skill` or read the `bard://skill` resource on the configured server, then use `tools/list` for available operations and schemas.

For local stdio, configure the MCP client to launch `bard-mcp` with `BARD_MCP_URL` and `BARD_TOKEN`. From a checkout, the equivalent command is `node /absolute/path/to/bard/mcp/server.js`. Run it on the human's device to allow local verification pages; remote clients use the hosted link returned by `bard_link_human`.
