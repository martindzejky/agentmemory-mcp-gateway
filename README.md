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

## Hosted consent CSRF

`GET /consent` requires an authenticated session and renders a short-lived HMAC token into both the Allow and Deny forms. The token is bound to the session ID, the exact raw signed OAuth query, an expiry, and a consent-CSRF domain marker.

`POST /consent` accepts nothing else as proof. A missing, malformed, expired, forged, wrong-session, or wrong-query token returns `403 {"error":"Request denied"}` and logs only a coarse reason such as `csrf_expired`. Browser `Origin`, `Referer`, and Fetch Metadata headers are neither trusted nor required, because hosted authentication windows (Safari in particular) send `Origin: null` and cross-site Fetch Metadata for a legitimate same-page form post.

After the token verifies, the gateway forwards the submission to Better Auth's `/oauth2/consent` with `Origin` pinned to `PUBLIC_URL`. Better Auth's own origin, CSRF, and signed-OAuth-query checks stay enabled, so a direct call to `/oauth2/consent` is still rejected.

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

`railway run` only injects variables into a **local** command. It cannot write to the Railway volume. Seed inside the deployed container after `/data` is mounted.

### Local

```sh
npm run seed-admin
# remove ADMIN_PASSWORD from .env
```

### Production image / Railway

The image includes `dist/seed-admin.js` and starts with `node dist/start.js`.

1. Generate a long random password in 1Password. Do not store it in git, SQLite, Docker, or logs.
2. Set temporary `ADMIN_EMAIL` and `ADMIN_PASSWORD` (20+ characters) on the service.
3. Deploy or restart so the container runs with `/data` mounted.
4. With those variables set, `node dist/start.js` runs `node dist/seed-admin.js` in-process, prints the durable user ID, and exits `0` without opening the HTTP port.
5. Remove `ADMIN_PASSWORD` and `ADMIN_EMAIL`, then restart. The process then serves HTTP.
6. If both variables are still set after a user exists, startup logs that they must be removed and exits `0` so Railway does not crash-loop.
7. If only one of `ADMIN_EMAIL` or `ADMIN_PASSWORD` is set, startup fails closed and does not serve HTTP.

Manual in-container equivalent after the volume exists:

```sh
railway ssh -- node dist/seed-admin.js
```

Do not use `railway run npm run seed-admin` for production seeding. That command runs on your machine.

The production HTTP process will not start until that one user exists and the seed variables are gone.

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

The entrypoint starts as root, verifies `DATABASE_PATH` is an absolute file under `/data` (or `RAILWAY_VOLUME_MOUNT_PATH`), `chown`s only that directory plus the SQLite/WAL/SHM files, then drops to UID/GID `10001` before `node` runs. It never recursively `chown`s `/` or other parents. Mount a persistent volume at `/data`.

## Railway

1. Create a new service from this repository. Do not deploy onto the AgentMemory service.
2. Use the Dockerfile / `railway.json` in the repo root.
3. Attach a persistent volume mounted at `/data`. Railway mounts volumes as root and replaces the image `/data` directory.
4. Set `RAILWAY_RUN_UID=0` so the entrypoint can `chown` `/data`, then drop to UID `10001`. Leaving the process as root is a tradeoff; this image does not keep root after startup.
5. Set replicas to **1**. A single SQLite volume cannot be shared safely.
6. Set the environment variables above. Use the private AgentMemory URL, such as `http://<agentmemory-service>.railway.internal:3111`.
7. Attach the public custom domain and set `PUBLIC_URL` to that exact `https://` origin.
8. Seed the administrator once with the in-container path above, then delete the temporary password variables.
9. Confirm `GET /healthz` returns `{"ok":true}`.

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

## MCP diagnostic logs

Railway shows HTTP status codes only, and MCP answers most protocol failures with `HTTP 200` and a JSON-RPC error inside the body. Every `/mcp` exchange therefore writes one-line JSON to stdout, or stderr when it failed:

```text
{"log":"mcp","ts":"...","event":"mcp.request","httpMethod":"POST","userAgent":"openai-mcp/1.0.0","envelope":"request","mcpMethod":"tools/list","rpcId":"2"}
{"log":"mcp","ts":"...","event":"agentmemory.list_tools.succeeded","upstreamStatus":200,"durationMs":2,"toolCount":3,"toolNames":["memory_recall","memory_smart_search","memory_save"]}
{"log":"mcp","ts":"...","event":"mcp.response","httpMethod":"POST","userAgent":"openai-mcp/1.0.0","envelope":"request","mcpMethod":"tools/list","rpcId":"2","httpStatus":200,"durationMs":4,"toolCount":3,"toolNames":["memory_recall","memory_smart_search","memory_save"]}
```

Filter Railway logs on `"log":"mcp"`. Useful events:

| Event                                    | Meaning                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `mcp.request`                            | An exchange started: MCP method, JSON-RPC id, envelope kind, agent |
| `mcp.response`                           | It finished: HTTP status, duration, and safe per-method detail     |
| `mcp.exception`                          | It threw instead of answering                                      |
| `mcp.sdk_error` / `mcp.server_error`     | The MCP SDK reported an out-of-band or protocol error              |
| `mcp.tools_list_failed`                  | The `tools/list` bridge handler threw, with stack and cause        |
| `mcp.tool_call_failed`                   | The `tools/call` bridge handler threw, with stack and cause        |
| `agentmemory.*.started/succeeded/failed` | Upstream AgentMemory call, with its HTTP status                    |

`mcp.response` adds the negotiated `protocolVersion` and advertised `capabilities` for `initialize`, `toolCount` plus `toolNames` for `tools/list`, and `rpcErrorCode` plus `rpcErrorMessage` whenever the body carries a JSON-RPC error. A `-32601 Method not found` line names the exact MCP method a client wanted but this gateway does not implement.

`src/mcp-log.ts` is the only writer. It accepts strings, numbers, booleans, and string arrays; anything else logs as `[unsupported]`. Field names that could carry a credential log as `[redacted]`, values are run through the same redaction as `safeLog`, and long values are truncated. Authorization headers, tokens, cookies, OAuth codes, tool arguments, tool results, memory contents, and request or response bodies are never logged.

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

- **Dockerfile** — Ubuntu 24.04, Node 24 (nvm) with npm 11, and [agentfiles](https://github.com/martindzejky/agentfiles)
- **install** — refreshes agentfiles and runs `npm ci` when `package-lock.json` exists

Local development, CI, Docker, and the gateway runtime all use Node 24 and npm 11. `.nvmrc` is `24`.
