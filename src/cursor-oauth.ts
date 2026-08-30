import type { GatewayAuth } from "./auth.js";
import { MCP_SCOPES } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { safeLog } from "./security.js";

/** Documented public client_id for Cursor static OAuth in mcp.json. */
export const CURSOR_OAUTH_CLIENT_ID = "cursor-mcp";

/** Durable marker so restart/provision can find this row without mutating others. */
export const CURSOR_OAUTH_SOFTWARE_ID = "agentmemory-mcp-gateway:cursor";

/**
 * Official Cursor static-OAuth callbacks.
 * @see https://cursor.com/docs/mcp
 */
export const CURSOR_OAUTH_REDIRECT_URIS = [
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "http://localhost:8787/callback",
] as const;

/**
 * Legacy desktop custom-scheme callback. Better Auth 1.7 rejects it for both
 * web (HTTPS required) and native (RFC 8252 reverse-domain scheme, no
 * authority) clients. Do not register it.
 */
export const CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI =
  "cursor://anysphere.cursor-mcp/oauth/callback";

export type OAuthClientRecord = {
  clientId: string;
  softwareId?: string | null;
  name?: string | null;
  redirectUris?: string[] | null;
  tokenEndpointAuthMethod?: string | null;
  applicationType?: string | null;
  grantTypes?: string[] | null;
  responseTypes?: string[] | null;
  scopes?: string[] | null;
  requirePKCE?: boolean | null;
  skipConsent?: boolean | null;
  disabled?: boolean | null;
  clientSecret?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type AuthInstance = GatewayAuth["auth"];

function asClient(row: unknown): OAuthClientRecord | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const client = row as OAuthClientRecord;
  if (typeof client.clientId !== "string" || client.clientId.length === 0) {
    return null;
  }
  return client;
}

async function oauthAdapter(auth: AuthInstance) {
  const context = await auth.$context;
  return context.adapter;
}

export async function listOAuthClients(auth: AuthInstance): Promise<OAuthClientRecord[]> {
  const adapter = await oauthAdapter(auth);
  const rows = await adapter.findMany({ model: "oauthClient" });
  return rows.map(asClient).filter((row): row is OAuthClientRecord => row !== null);
}

export async function findCursorOAuthClient(auth: AuthInstance): Promise<OAuthClientRecord | null> {
  const adapter = await oauthAdapter(auth);
  return asClient(
    await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: CURSOR_OAUTH_CLIENT_ID }],
    }),
  );
}

async function linkMcpResource(
  auth: AuthInstance,
  clientId: string,
  resource: string,
): Promise<void> {
  const adapter = await oauthAdapter(auth);
  const existing = await adapter.findOne({
    model: "oauthResource",
    where: [{ field: "identifier", value: resource }],
  });
  if (!existing) {
    return;
  }
  const linked = await adapter.findOne({
    model: "oauthClientResource",
    where: [
      { field: "clientId", value: clientId },
      { field: "resourceId", value: resource },
    ],
  });
  if (linked) {
    return;
  }
  await adapter.create({
    model: "oauthClientResource",
    data: {
      clientId,
      resourceId: resource,
      createdAt: new Date(),
    },
  });
}

/**
 * Idempotent startup provision of the Cursor static public OAuth client.
 *
 * Creates the row only when client_id `cursor-mcp` is absent. A DCR
 * client that copies the software id is ignored and is not overwritten.
 */
export async function provisionCursorOAuthClient(
  auth: AuthInstance,
  config: Pick<GatewayConfig, "mcpResource">,
): Promise<{ clientId: string; created: boolean }> {
  const existing = await findCursorOAuthClient(auth);
  if (existing) {
    safeLog("cursor oauth client ready", { clientId: existing.clientId, created: false });
    return { clientId: existing.clientId, created: false };
  }

  const now = new Date();
  const adapter = await oauthAdapter(auth);
  try {
    await adapter.create({
      model: "oauthClient",
      data: {
        clientId: CURSOR_OAUTH_CLIENT_ID,
        name: "Cursor",
        softwareId: CURSOR_OAUTH_SOFTWARE_ID,
        redirectUris: [...CURSOR_OAUTH_REDIRECT_URIS],
        tokenEndpointAuthMethod: "none",
        applicationType: "native",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopes: [...MCP_SCOPES],
        requirePKCE: true,
        skipConsent: false,
        disabled: false,
        subjectType: "public",
        clientCredentialsScopes: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch {
    const raced = await findCursorOAuthClient(auth);
    if (raced) {
      safeLog("cursor oauth client ready", { clientId: raced.clientId, created: false });
      return { clientId: raced.clientId, created: false };
    }
    throw new Error("Failed to provision the Cursor OAuth client");
  }
  await linkMcpResource(auth, CURSOR_OAUTH_CLIENT_ID, config.mcpResource);
  safeLog("cursor oauth client ready", { clientId: CURSOR_OAUTH_CLIENT_ID, created: true });
  return { clientId: CURSOR_OAUTH_CLIENT_ID, created: true };
}
