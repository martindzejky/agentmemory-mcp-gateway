import { afterEach, describe, expect, it } from "vitest";
import { isAdminSubject } from "../src/auth.js";
import { startGateway, request, type startGateway as StartGateway } from "./helpers.js";

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

describe("OAuth discovery and challenges", () => {
  it("exposes authorization-server discovery", async () => {
    const { gateway, config } = await boot();
    const response = await request(gateway.app, "/.well-known/oauth-authorization-server", {
      host: config.publicHost,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(config.publicUrl);
    expect(body.authorization_endpoint).toBe(`${config.publicUrl}/oauth2/authorize`);
    expect(body.token_endpoint).toBe(`${config.publicUrl}/oauth2/token`);
    expect(body.registration_endpoint).toBe(`${config.publicUrl}/oauth2/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(JSON.stringify(body)).not.toContain(config.betterAuthSecret);
    expect(JSON.stringify(body)).not.toContain(config.agentmemorySecret);
  });

  it("exposes protected-resource metadata", async () => {
    const { gateway, config } = await boot();
    const response = await request(gateway.app, "/.well-known/oauth-protected-resource", {
      host: config.publicHost,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource).toBe(config.mcpResource);
    expect(body.authorization_servers).toEqual([config.publicUrl]);
    expect(body.bearer_methods_supported).toContain("header");
    expect(JSON.stringify(body)).not.toContain(config.agentmemorySecret);
  });

  it("returns 401 and WWW-Authenticate for unauthenticated MCP requests", async () => {
    const { gateway, config } = await boot();
    const response = await request(gateway.app, "/mcp", {
      method: "POST",
      host: config.publicHost,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge.toLowerCase()).toContain("bearer");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
    const text = await response.text();
    expect(text).not.toContain(config.agentmemorySecret);
    expect(text).not.toContain(config.betterAuthSecret);
  });

  it("rejects a subject that is not the sole admin", () => {
    expect(isAdminSubject("admin-1", "admin-1")).toBe(true);
    expect(isAdminSubject("admin-1", "someone-else")).toBe(false);
    expect(isAdminSubject("admin-1", undefined)).toBe(false);
  });
});
