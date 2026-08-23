# agentmemory-mcp-gateway

Single-user OAuth 2.1 gateway that exposes a small AgentMemory MCP tool set to remote clients.

MCP clients authenticate to this service. This service authenticates to AgentMemory. The AgentMemory backend secret never leaves the gateway.

## What it does

- Speaks remote MCP over Streamable HTTP at `/mcp`
- Acts as the OAuth authorization server and protected resource
- Allows exactly one pre-seeded human to sign in and grant consent
- Forwards allowlisted `tools/list` and `tools/call` traffic to AgentMemory REST
- Fails closed when AgentMemory is unavailable

Intended clients: ChatGPT, Notion Custom Agents, Codex cloud, and other standards-compliant remote MCP clients.

Public URL shape:

```text
https://memory-mcp.example.com/mcp
```

## Architecture

```text
MCP client
  -> HTTPS gateway (this service)
    -> private AgentMemory REST API
```

Trust boundaries:

- MCP clients see only the public HTTPS origin, OAuth metadata, and allowlisted tool schemas/results.
- AgentMemory stays on Railway private networking. Clients never receive `AGENTMEMORY_URL` or `AGENTMEMORY_SECRET`.
- Incoming `Authorization` headers are used only to validate the client access token. The gateway always builds a new `Authorization: Bearer ${AGENTMEMORY_SECRET}` header for upstream calls.
- SQLite stores authentication and OAuth state only. It is not a memory database.

This is a separate Railway service from AgentMemory. Run exactly one replica.

## Why REST instead of `@agentmemory/mcp`

`@agentmemory/mcp` can fall back to a local memory database when upstream is unreachable. That is unacceptable for a remote personal gateway.

This service calls only:

- `GET /agentmemory/mcp/tools`
- `POST /agentmemory/mcp/call` with `{ "name": string, "arguments": object }`

If AgentMemory is down, malformed, or times out, the gateway returns a safe MCP error. It does not create, open, or write another memory store.

## Why SQLite exists

SQLite at `DATABASE_PATH` (default `/data/oauth.sqlite`) holds:

- the one user and password hash
- sessions and consent
- OAuth client registrations
- authorization codes
- access/refresh-token and revocation state
- signing keys / JWKS

It never stores AgentMemory observations or embeddings.

The in-memory rate limiter is also single-replica only. Do not scale this service horizontally.

## Strict single-user model

- Email/password only
- No GitHub, social login, magic links, invitations, or password recovery
- No public signup and no user-management API
- Client registration (CIMD / DCR) is not human registration
- Only the seeded user's durable ID may sign in, approve consent, or receive usable MCP tokens
- Production startup fails if the user table does not contain exactly one row

Authentication errors are generic. They do not disclose whether an email exists.

## Environment

| Variable             | Required  | Purpose                                                                                   |
| -------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_URL`         | yes       | Canonical public origin. No path, query, fragment, or credentials. HTTPS except loopback. |
| `BETTER_AUTH_SECRET` | yes       | Better Auth signing/encryption secret, 32+ characters                                     |
| `DATABASE_PATH`      | yes       | SQLite file path, for example `/data/oauth.sqlite`                                        |
| `AGENTMEMORY_URL`    | yes       | Private AgentMemory origin                                                                |
| `AGENTMEMORY_SECRET` | yes       | Backend bearer for AgentMemory, 32+ characters                                            |
| `ALLOWED_TOOLS`      | no        | Default `memory_recall,memory_smart_search,memory_save`                                   |
| `PORT`               | no        | Listen port. Railway sets this. Default `8080`                                            |
| `ADMIN_EMAIL`        | seed only | Administrator email                                                                       |
| `ADMIN_PASSWORD`     | seed only | Strong generated password, 20+ characters                                                 |

`PUBLIC_URL` is the single issuer and the origin for `/mcp`. The protected resource identifier is `${PUBLIC_URL}/mcp`.

Copy `.env.example`. It contains placeholders only.

## Local development

```sh
nvm install
cp .env.example .env
# fill local loopback values, for example PUBLIC_URL=http://127.0.0.1:8080
npm install
npm run seed-admin
# remove ADMIN_PASSWORD from .env
npm run dev
```

Useful checks:

```sh
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

## Secure one-time administrator seeding

1. Generate a long random password in 1Password. Do not store it in git, SQLite, Docker, or logs.
2. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` only in the shell or a temporary Railway variable.
3. Run `npm run seed-admin` against the mounted `/data` volume, or `railway run npm run seed-admin` after the volume exists.
4. The command creates the user only when the user table is empty. It refuses if any user exists.
5. It prints the durable user ID. It never prints the password.
6. Remove `ADMIN_PASSWORD` and `ADMIN_EMAIL` immediately.

The production process will not start until that one user exists.

## Docker

```sh
docker build -t agentmemory-mcp-gateway .
docker run --rm -p 8080:8080 \
  -e PUBLIC_URL=http://127.0.0.1:8080 \
  -e BETTER_AUTH_SECRET=... \
  -e DATABASE_PATH=/data/oauth.sqlite \
  -e AGENTMEMORY_URL=http://127.0.0.1:3111 \
  -e AGENTMEMORY_SECRET=... \
  -v gateway-data:/data \
  agentmemory-mcp-gateway
```

The image runs as a non-root user. Mount a persistent volume at `/data`.

## Railway

1. Create a new service from this repository. Do not deploy onto the AgentMemory service.
2. Use the Dockerfile / `railway.json` in the repo root.
3. Attach a persistent volume mounted at `/data`.
4. Set replicas to **1**. A single SQLite volume cannot be shared safely.
5. Set the environment variables above. Use the private AgentMemory URL, such as `http://<agentmemory-service>.railway.internal:3111`.
6. Attach the public custom domain and set `PUBLIC_URL` to that exact `https://` origin.
7. Seed the administrator once, then delete the temporary password variable.
8. Confirm `GET /healthz` returns `{"ok":true}`.

Do not put AgentMemory on the public internet for this flow. The gateway is the only public MCP endpoint.

## Connecting ChatGPT

1. Deploy with a stable HTTPS origin and `/mcp`.
2. In ChatGPT, add a remote MCP / connector URL: `https://<your-domain>/mcp`.
3. Prefer CIMD if ChatGPT offers it. DCR remains enabled as a fallback.
4. Complete the hosted sign-in and consent screens as the seeded user.
5. Confirm `memory_recall`, `memory_smart_search`, and `memory_save` appear.

ChatGPT discovers `/.well-known/oauth-protected-resource` and the authorization-server metadata automatically.

## Connecting Notion Custom Agents

1. Enable custom MCP servers in the Notion workspace if required.
2. Add a custom MCP server URL: `https://<your-domain>/mcp`.
3. Notion uses OAuth and typically DCR unless a client is preregistered.
4. Sign in as the seeded user and approve consent.
5. Enable only the tools that agent should use.

## Basic end-to-end verification

```sh
curl -sS https://<your-domain>/healthz
curl -sS https://<your-domain>/.well-known/oauth-authorization-server
curl -sS https://<your-domain>/.well-known/oauth-protected-resource
curl -sS -D- https://<your-domain>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

The `/mcp` call must return `401` with a `WWW-Authenticate` challenge that points at protected-resource metadata. After a real client login, `tools/list` must show only the allowlisted tools.

## Revoking clients and tokens

SQLite is the source of truth for OAuth clients, refresh tokens, and consent.

- Delete or rotate `BETTER_AUTH_SECRET` only if you intend to invalidate signing material and re-seed carefully.
- Removing an `oauthClient` row, related tokens, and consent records revokes that client.
- Replacing the SQLite file logs every client out.

There is no admin API. Use a one-off sqlite3 session against the volume if you need to revoke a specific client.

## Backup and recovery

Copy `/data/oauth.sqlite` and the `-wal`/`-shm` files together while the service is stopped, or use `sqlite3 .backup`. A lost volume means every OAuth client must reconnect and the administrator must be seeded again. This backup is authentication state, not AgentMemory.

## Known limitations

- One replica only. Rate limits are in-memory.
- No password reset. If the password is lost, restore SQLite from backup or delete the user table and seed again.
- No dashboard and no multi-user support.
- The MCP handler keeps official SDK legacy (`2025`) protocol support in stateless mode so ChatGPT and Notion are not rejected. The OAuth stack follows current Better Auth MCP APIs, including CIMD plus explicit DCR.
- mTLS client authentication advertised by ChatGPT is terminated at the HTTPS edge, not verified inside this process.

## Cloud agents

Cursor Cloud uses `.cursor/environment.json`:

- **Dockerfile** — Ubuntu 24.04, Node 24 (nvm), npm, and [agentfiles](https://github.com/martindzejky/agentfiles)
- **install** — refreshes agentfiles and runs `npm ci` when `package-lock.json` exists

Local development uses the same Node version via `.nvmrc` for the cloud image. The gateway runtime itself targets Node 22.
