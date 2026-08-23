# agentmemory-mcp-gateway

MCP gateway for [AgentMemory](https://github.com/martindzejky/agentmemory) with OAuth.

## Cloud agents

Cursor Cloud uses `.cursor/environment.json`:

- **Dockerfile** — Ubuntu 24.04, Node 24 (nvm), npm, and [agentfiles](https://github.com/martindzejky/agentfiles)
- **install** — refreshes agentfiles and runs `npm ci` when `package-lock.json` exists

Local development uses the same Node version via `.nvmrc`.

## Local setup

```sh
nvm install
npm install
```
