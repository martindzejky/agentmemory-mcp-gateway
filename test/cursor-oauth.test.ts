import { hashPassword } from "better-auth/crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI,
  CURSOR_OAUTH_CLIENT_ID,
  CURSOR_OAUTH_REDIRECT_URIS,
  CURSOR_OAUTH_SOFTWARE_ID,
  findCursorOAuthClient,
  listOAuthClients,
  provisionCursorOAuthClient,
} from "../src/cursor-oauth.js";
import type { GatewayConfig } from "../src/config.js";
import {
  getAccessToken,
  pkce,
  registerClient,
  request,
  signIn,
  startGateway,
  type startGateway as StartGateway,
} from "./helpers.js";

let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  restore?.();
  close?.();
  restore = undefined;
  close = undefined;
});

async function boot(options?: Parameters<typeof StartGateway>[0]) {
  const ctx = await startGateway(options);
  restore = ctx.restoreFetch;
  close = () => ctx.gateway.close();
  return ctx;
}

function snapshotClients(
  clients: Awaited<ReturnType<typeof listOAuthClients>>,
): Array<Record<string, unknown>> {
  return [...clients]
    .map((client) => ({
      clientId: client.clientId,
      softwareId: client.softwareId ?? null,
      name: client.name ?? null,
      redirectUris: client.redirectUris ?? null,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod ?? null,
      applicationType: client.applicationType ?? null,
      grantTypes: client.grantTypes ?? null,
      clientSecret: client.clientSecret ?? null,
      skipConsent: client.skipConsent ?? null,
      disabled: client.disabled ?? null,
    }))
    .sort((left, right) => String(left.clientId).localeCompare(String(right.clientId)));
}

async function authorize(
  app: Parameters<typeof request>[0],
  config: GatewayConfig,
  input: { clientId: string; redirectUri: string },
): Promise<Response> {
  const { challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: "openid profile offline_access mcp:tools",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: config.mcpResource,
    state: "test-state",
  });
  const cookies = await signIn(app, config, query.toString());
  return request(app, `/oauth2/authorize?${query}`, {
    host: config.publicHost,
    headers: { cookie: cookies },
    redirect: "manual",
  });
}

function jwtSubject(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string };
  return claims.sub;
}

describe("Cursor static OAuth client", () => {
  it("provisions a public native Cursor client with the official redirect URIs", async () => {
    const { gateway } = await boot();
    const client = await findCursorOAuthClient(gateway.auth);
    expect(client?.clientId).toBe(CURSOR_OAUTH_CLIENT_ID);
    expect(client?.softwareId).toBe(CURSOR_OAUTH_SOFTWARE_ID);
    expect(client?.applicationType).toBe("native");
    expect(client?.tokenEndpointAuthMethod).toBe("none");
    expect(client?.clientSecret).toBeFalsy();
    expect(client?.skipConsent).toBeFalsy();
    expect(client?.redirectUris).toEqual([...CURSOR_OAUTH_REDIRECT_URIS]);
    expect(client?.redirectUris).not.toContain(CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI);
  });

  it("accepts each approved Cursor redirect URI and issues a token for the admin only", async () => {
    const { gateway, config } = await boot();
    for (const redirectUri of CURSOR_OAUTH_REDIRECT_URIS) {
      const token = await getAccessToken(gateway.app, config, {
        clientId: CURSOR_OAUTH_CLIENT_ID,
        redirectUri,
      });
      expect(jwtSubject(token)).toBe(gateway.adminUserId);
    }
  });

  it("rejects an attacker-controlled redirect URI", async () => {
    const { gateway, config } = await boot();
    const response = await authorize(gateway.app, config, {
      clientId: CURSOR_OAUTH_CLIENT_ID,
      redirectUri: "https://evil.example/callback",
    });
    const location = response.headers.get("location") ?? "";
    const body = await response.text();
    expect(location).not.toContain("evil.example");
    expect(`${location}\n${body}`).not.toMatch(/[?&]code=/);
  });

  it("rejects the legacy cursor:// callback without weakening validation", async () => {
    const { gateway, config } = await boot();
    const dcrWebDefault = await request(gateway.app, "/oauth2/register", {
      method: "POST",
      host: config.publicHost,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "cursor-dcr-web-default",
        redirect_uris: [CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(dcrWebDefault.status).toBe(400);
    expect(await dcrWebDefault.text()).toMatch(/web clients require https redirect URIs/i);

    const dcrNative = await request(gateway.app, "/oauth2/register", {
      method: "POST",
      host: config.publicHost,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "cursor-dcr-native",
        redirect_uris: [CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI],
        application_type: "native",
        token_endpoint_auth_method: "none",
      }),
    });
    expect(dcrNative.status).toBe(400);
    expect(await dcrNative.text()).toMatch(/reverse-domain/i);

    const authorizeLegacy = await authorize(gateway.app, config, {
      clientId: CURSOR_OAUTH_CLIENT_ID,
      redirectUri: CURSOR_LEGACY_CUSTOM_SCHEME_REDIRECT_URI,
    });
    const location = authorizeLegacy.headers.get("location") ?? "";
    expect(location).not.toContain("cursor://");
    expect(location).not.toMatch(/[?&]code=/);
  });

  it("does not let a second user complete Cursor OAuth", async () => {
    const { gateway, config } = await boot();
    const adminToken = await getAccessToken(gateway.app, config, {
      clientId: CURSOR_OAUTH_CLIENT_ID,
      redirectUri: CURSOR_OAUTH_REDIRECT_URIS[1],
    });
    expect(jwtSubject(adminToken)).toBe(gateway.adminUserId);

    const passwordHash = await hashPassword("zzzzzzzzzzzzzzzzzzzz");
    gateway.db
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "intruder-id",
        "Intruder",
        "intruder@example.com",
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    gateway.db
      .prepare(
        `INSERT INTO account (id, accountId, providerId, issuer, userId, password, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "intruder-account",
        "intruder@example.com",
        "credential",
        "credential",
        "intruder-id",
        passwordHash,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const login = await request(gateway.app, "/sign-in", {
      method: "POST",
      host: config.publicHost,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "intruder@example.com",
        password: "zzzzzzzzzzzzzzzzzzzz",
      }),
      redirect: "manual",
    });
    const loginBody = await login.text();
    expect(login.status === 303 ? login.headers.get("location") : loginBody).toMatch(
      /error=1|Invalid email or password/i,
    );
    expect(login.headers.get("set-cookie") ?? "").not.toMatch(/better-auth|session/i);
    expect(jwtSubject(adminToken)).not.toBe("intruder-id");
  });

  it("leaves existing OAuth clients untouched and is idempotent", async () => {
    const first = await startGateway();
    restore = first.restoreFetch;
    const dcr = await registerClient(first.gateway.app, first.config, {
      client_name: "preexisting-notion-like",
    });
    const before = snapshotClients(await listOAuthClients(first.gateway.auth));
    expect(before.some((client) => client.clientId === dcr.client_id)).toBe(true);
    expect(before.filter((client) => client.softwareId === CURSOR_OAUTH_SOFTWARE_ID)).toHaveLength(
      1,
    );

    const secondProvision = await provisionCursorOAuthClient(first.gateway.auth, first.config);
    expect(secondProvision).toEqual({ clientId: CURSOR_OAUTH_CLIENT_ID, created: false });
    expect(snapshotClients(await listOAuthClients(first.gateway.auth))).toEqual(before);

    first.gateway.close();
    close = undefined;

    const second = await startGateway({ env: first.env, seed: false });
    close = () => second.gateway.close();
    restore = second.restoreFetch;
    const afterRestart = snapshotClients(await listOAuthClients(second.gateway.auth));
    expect(afterRestart).toEqual(before);
    expect(afterRestart.filter((client) => client.clientId === dcr.client_id)).toHaveLength(1);
    expect(
      afterRestart.filter((client) => client.softwareId === CURSOR_OAUTH_SOFTWARE_ID),
    ).toHaveLength(1);
  });

  it("does not let a DCR software_id squat block the Cursor client", async () => {
    const { gateway, config } = await boot();
    gateway.db.prepare(`DELETE FROM oauthClient WHERE clientId = ?`).run(CURSOR_OAUTH_CLIENT_ID);
    expect(await findCursorOAuthClient(gateway.auth)).toBeNull();

    const squat = await registerClient(gateway.app, config, {
      client_name: "software-id-squatter",
      software_id: CURSOR_OAUTH_SOFTWARE_ID,
    });
    expect(squat.client_id).not.toBe(CURSOR_OAUTH_CLIENT_ID);

    const created = await provisionCursorOAuthClient(gateway.auth, config);
    expect(created).toEqual({ clientId: CURSOR_OAUTH_CLIENT_ID, created: true });

    const clients = await listOAuthClients(gateway.auth);
    expect(clients.some((client) => client.clientId === squat.client_id)).toBe(true);
    const cursor = clients.find((client) => client.clientId === CURSOR_OAUTH_CLIENT_ID);
    expect(cursor?.softwareId).toBe(CURSOR_OAUTH_SOFTWARE_ID);
  });
});
