import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_TOKEN, getAccessToken, mcpRequest, startGateway } from "./helpers.js";

let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  restore?.();
  close?.();
  restore = undefined;
  close = undefined;
});

async function boot() {
  const ctx = await startGateway();
  restore = ctx.restoreFetch;
  close = () => ctx.gateway.close();
  return ctx;
}

async function parseMcp(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const jsonLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("{") || line.startsWith("data: {"));
  const raw = jsonLine?.startsWith("data: ") ? jsonLine.slice(6) : (jsonLine ?? text);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("MCP bridge", () => {
  it("lists only allowlisted tools", async () => {
    const { gateway, config } = await boot();
    const token = await getAccessToken(gateway.app, config);
    const response = await mcpRequest(gateway.app, config, "tools/list", {}, token);
    expect(response.status).toBe(200);
    const body = await parseMcp(response);
    const result = body.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "memory_recall",
      "memory_save",
      "memory_smart_search",
    ]);
    expect(result.tools.some((tool) => tool.name === "memory_export")).toBe(false);
  });

  it("rejects disallowed calls before AgentMemory is contacted", async () => {
    const { gateway, config, mock } = await boot();
    const token = await getAccessToken(gateway.app, config);
    mock.calls.length = 0;
    const response = await mcpRequest(
      gateway.app,
      config,
      "tools/call",
      { name: "memory_export", arguments: {} },
      token,
    );
    expect(response.status).toBe(200);
    const body = await parseMcp(response);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available");
    expect(mock.calls.some((call) => call.url.endsWith("/agentmemory/mcp/call"))).toBe(false);
  });

  it("sends only the backend bearer and never the client token", async () => {
    const { gateway, config, mock } = await boot();
    const token = await getAccessToken(gateway.app, config);
    mock.calls.length = 0;
    const response = await mcpRequest(
      gateway.app,
      config,
      "tools/call",
      { name: "memory_recall", arguments: { query: "auth" } },
      token,
    );
    expect(response.status).toBe(200);
    expect(mock.calls.length).toBeGreaterThan(0);
    for (const call of mock.calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${config.agentmemorySecret}`);
      expect(call.headers.get("authorization")).not.toBe(`Bearer ${token}`);
      expect(call.headers.get("authorization")).not.toBe(`Bearer ${CLIENT_TOKEN}`);
    }
  });

  it("returns an MCP error when AgentMemory is unavailable", async () => {
    const { gateway, config, mock } = await boot();
    const token = await getAccessToken(gateway.app, config);
    mock.fail = true;
    const response = await mcpRequest(
      gateway.app,
      config,
      "tools/call",
      { name: "memory_recall", arguments: { query: "auth" } },
      token,
    );
    const body = await parseMcp(response);
    const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unavailable|invalid/i);
    expect(JSON.stringify(body)).not.toContain("sqlite");
    expect(JSON.stringify(body)).not.toContain(config.agentmemoryUrl);
  });

  it("fails closed on malformed upstream responses", async () => {
    const { gateway, config, mock } = await boot();
    const token = await getAccessToken(gateway.app, config);
    mock.callHandler = () => Response.json({ unexpected: true });
    const response = await mcpRequest(
      gateway.app,
      config,
      "tools/call",
      { name: "memory_recall", arguments: { query: "auth" } },
      token,
    );
    const body = await parseMcp(response);
    const result = body.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
