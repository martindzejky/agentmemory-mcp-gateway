import { afterEach, describe, expect, it } from "vitest";
import {
  logMcpEvent,
  summarizeMcpEnvelope,
  summarizeMcpResult,
  type McpLogField,
} from "../src/mcp-log.js";
import { instrumentExchange } from "../src/mcp.js";
import { redactValue } from "../src/security.js";
import {
  ADMIN_PASSWORD,
  AUTH_SECRET,
  BACKEND_SECRET,
  CLIENT_TOKEN,
  captureLogs,
  getAccessToken,
  mcpRawRequest,
  mcpRequest,
  request,
  startGateway,
  type CapturedLogs,
} from "./helpers.js";

const CHATGPT_AGENT = "openai-mcp/1.0.0";

let logs: CapturedLogs | undefined;
let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  logs?.restore();
  restore?.();
  close?.();
  logs = undefined;
  restore = undefined;
  close = undefined;
});

async function boot() {
  const ctx = await startGateway();
  restore = ctx.restoreFetch;
  close = () => ctx.gateway.close();
  const token = await getAccessToken(ctx.gateway.app, ctx.config);
  logs = captureLogs();
  return { ...ctx, token, logs };
}

function lastEntry(captured: CapturedLogs, event: string): Record<string, unknown> {
  const entries = captured.entries(event);
  expect(entries.length, `expected a ${event} log entry`).toBeGreaterThan(0);
  return entries[entries.length - 1]!;
}

describe("safe diagnostic log fields", () => {
  afterEach(() => {
    logs?.restore();
    logs = undefined;
  });

  it("redacts fields whose name could carry a credential", () => {
    logs = captureLogs();
    logMcpEvent("info", "test.event", {
      authorization: "Bearer abc.def.ghi",
      cookie: "session=1",
      code: "oauth-code",
      toolArguments: "query text",
      params: "everything",
      mcpMethod: "tools/call",
    });
    const entry = lastEntry(logs, "test.event");
    expect(entry.authorization).toBe("[redacted]");
    expect(entry.cookie).toBe("[redacted]");
    expect(entry.code).toBe("[redacted]");
    expect(entry.toolArguments).toBe("[redacted]");
    expect(entry.params).toBe("[redacted]");
    expect(entry.mcpMethod).toBe("tools/call");
  });

  it("redacts credential-shaped values and refuses non-scalar fields", () => {
    logs = captureLogs();
    logMcpEvent("info", "test.event", {
      errorMessage: "upstream said Bearer eyJhbGciOi.J9",
      rpcErrorMessage: "the access_token expired",
      blob: { memory: "private" } as unknown as McpLogField,
      rpcErrorCode: -32603,
    });
    const entry = lastEntry(logs, "test.event");
    expect(entry.errorMessage).toBe("[redacted]");
    expect(entry.rpcErrorMessage).toBe("[redacted]");
    expect(entry.blob).toBe("[unsupported]");
    expect(entry.rpcErrorCode).toBe(-32603);
  });

  it("truncates long values and long lists", () => {
    logs = captureLogs();
    logMcpEvent("info", "test.event", {
      note: "n".repeat(400),
      toolNames: Array.from({ length: 60 }, (_, index) => `tool_${index}`),
    });
    const entry = lastEntry(logs, "test.event");
    expect(String(entry.note)).toHaveLength(303);
    expect(String(entry.note).endsWith("...")).toBe(true);
    expect(entry.toolNames).toHaveLength(50);
  });

  it("writes failures to stderr and successes to stdout", () => {
    logs = captureLogs();
    logMcpEvent("info", "test.ok");
    logMcpEvent("error", "test.bad");
    expect(logs.lines.map((line) => line.level)).toEqual(["info", "error"]);
  });
});

describe("MCP envelope and result summaries", () => {
  it("reads only the JSON-RPC method and id from a request body", () => {
    expect(
      summarizeMcpEnvelope(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "memory_save", arguments: { text: "PRIVATE-NOTE" } },
        }),
      ),
    ).toEqual({ envelope: "request", mcpMethod: "tools/call", rpcId: "7" });
  });

  it("classifies notifications, batches, responses, and junk", () => {
    expect(summarizeMcpEnvelope('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({
      envelope: "notification",
      mcpMethod: "notifications/initialized",
      rpcId: undefined,
    });
    expect(
      summarizeMcpEnvelope('[{"method":"initialize","id":1},{"method":"tools/list","id":2}]'),
    ).toEqual({
      envelope: "batch",
      batchSize: 2,
      mcpMethods: ["initialize", "tools/list"],
    });
    expect(summarizeMcpEnvelope('{"jsonrpc":"2.0","id":3,"result":{}}')).toEqual({
      envelope: "response",
      rpcId: "3",
    });
    expect(summarizeMcpEnvelope("not json").envelope).toBe("unparseable");
    expect(summarizeMcpEnvelope("  ").envelope).toBe("empty");
  });

  it("extracts the initialize handshake from an SSE frame", () => {
    const body = [
      "event: message",
      'data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}},"id":1}',
      "",
    ].join("\n");
    expect(summarizeMcpResult(body, "initialize")).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: ["tools"],
    });
  });

  it("extracts tool names for tools/list and nothing for tools/call results", () => {
    const toolsBody = JSON.stringify({
      result: { tools: [{ name: "memory_recall" }, { name: "memory_save" }] },
    });
    expect(summarizeMcpResult(toolsBody, "tools/list")).toEqual({
      toolCount: 2,
      toolNames: ["memory_recall", "memory_save"],
    });
    expect(summarizeMcpResult(toolsBody, "tools/call")).toEqual({});

    const callBody = JSON.stringify({
      result: { content: [{ type: "text", text: "PRIVATE-MEMORY" }], isError: false },
    });
    expect(summarizeMcpResult(callBody, "tools/call")).toEqual({ toolCallIsError: false });
  });

  it("extracts a JSON-RPC error code and message", () => {
    expect(
      summarizeMcpResult('{"error":{"code":-32601,"message":"Method not found"},"id":1}', "ping"),
    ).toEqual({ rpcErrorCode: -32601, rpcErrorMessage: "Method not found" });
  });
});

describe("diagnostics never disturb the client response", () => {
  afterEach(() => {
    logs?.restore();
    logs = undefined;
  });

  function toolsListRequest(): Request {
    return new Request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
  }

  it("hands back the handler's own response object, unread", async () => {
    logs = captureLogs();
    const handled = new Response('data: {"result":{"tools":[{"name":"memory_save"}]},"id":1}\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const response = await instrumentExchange(toolsListRequest(), async () => handled);

    expect(response).toBe(handled);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toContain("memory_save");
    expect(lastEntry(logs, "mcp.response")).toMatchObject({ toolCount: 1 });
  });

  it("keeps the response intact when its body cannot be read", async () => {
    logs = captureLogs();
    const handled = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("upstream stream broke"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const response = await instrumentExchange(toolsListRequest(), async () => handled);

    expect(response).toBe(handled);
    expect(response.bodyUsed).toBe(false);
    expect(logs.entries("mcp.response_unreadable")).toHaveLength(1);
    expect(lastEntry(logs, "mcp.response")).toMatchObject({
      mcpMethod: "tools/list",
      httpStatus: 200,
    });
  });

  it("rethrows a handler exception after logging it", async () => {
    logs = captureLogs();
    const failure = new Error("handler exploded");
    await expect(
      instrumentExchange(toolsListRequest(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(lastEntry(logs, "mcp.exception")).toMatchObject({
      mcpMethod: "tools/list",
      errorMessage: "handler exploded",
    });
  });
});

describe("non-MCP route exceptions", () => {
  // Not keyword-shaped, so redactValue cannot save us. Only withholding the
  // message and stack keeps a value like this out of the logs.
  const SENTINEL = "7EWcMQHTb0YVbZVS3eCtTS8PgnSHsZ0R";

  it("logs no exception detail for a route that handles credentials", async () => {
    const ctx = await startGateway();
    restore = ctx.restoreFetch;
    close = () => ctx.gateway.close();
    expect(redactValue(SENTINEL)).toBe(SENTINEL);

    logs = captureLogs();
    const original = ctx.gateway.auth.handler;
    ctx.gateway.auth.handler = async () => {
      throw new Error(`invalid grant ${SENTINEL}`);
    };
    try {
      const response = await request(ctx.gateway.app, "/oauth2/token", {
        method: "POST",
        host: ctx.config.publicHost,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code" }),
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Request denied" });
    } finally {
      ctx.gateway.auth.handler = original;
    }

    // An exact match proves no errorMessage, stack, or causeMessage slipped in.
    expect(lastEntry(logs, "gateway.unhandled_error")).toEqual({
      log: "mcp",
      ts: expect.any(String),
      event: "gateway.unhandled_error",
      path: "/oauth2/token",
      errorName: "Error",
    });
    expect(logs.text()).not.toContain(SENTINEL);
  });
});

describe("MCP endpoint diagnostics", () => {
  it("logs the negotiated initialize handshake", async () => {
    const ctx = await boot();
    const response = await mcpRequest(
      ctx.gateway.app,
      ctx.config,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openai-mcp", version: "1.0.0" },
      },
      ctx.token,
      { "user-agent": CHATGPT_AGENT },
    );
    expect(response.status).toBe(200);

    const started = lastEntry(ctx.logs, "mcp.request");
    expect(started).toMatchObject({
      httpMethod: "POST",
      envelope: "request",
      mcpMethod: "initialize",
      rpcId: "1",
      userAgent: CHATGPT_AGENT,
    });

    const finished = lastEntry(ctx.logs, "mcp.response");
    expect(finished).toMatchObject({
      mcpMethod: "initialize",
      rpcId: "1",
      httpStatus: 200,
      protocolVersion: "2025-06-18",
      userAgent: CHATGPT_AGENT,
    });
    expect(finished.capabilities).toContain("tools");
    expect(typeof finished.durationMs).toBe("number");
  });

  it("logs the tool count and names for tools/list, upstream and downstream", async () => {
    const ctx = await boot();
    await mcpRequest(ctx.gateway.app, ctx.config, "tools/list", {}, ctx.token, {
      "user-agent": CHATGPT_AGENT,
    });

    expect(ctx.logs.entries("agentmemory.list_tools.started")).toHaveLength(1);
    const upstream = lastEntry(ctx.logs, "agentmemory.list_tools.succeeded");
    expect(upstream).toMatchObject({ upstreamStatus: 200, toolCount: 3 });
    expect(upstream.toolNames).toEqual(["memory_recall", "memory_smart_search", "memory_save"]);
    expect(upstream.toolNames).not.toContain("memory_export");

    const finished = lastEntry(ctx.logs, "mcp.response");
    expect(finished).toMatchObject({ mcpMethod: "tools/list", httpStatus: 200, toolCount: 3 });
    expect(finished.toolNames).toEqual(["memory_recall", "memory_smart_search", "memory_save"]);
  });

  it("logs a notification that carries no JSON-RPC id", async () => {
    const ctx = await boot();
    await mcpRawRequest(
      ctx.gateway.app,
      ctx.config,
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      ctx.token,
      { "user-agent": CHATGPT_AGENT },
    );
    const started = lastEntry(ctx.logs, "mcp.request");
    expect(started).toMatchObject({
      envelope: "notification",
      mcpMethod: "notifications/initialized",
    });
    expect(started.rpcId).toBeUndefined();
    expect(typeof lastEntry(ctx.logs, "mcp.response").httpStatus).toBe("number");
  });

  it("logs a method the gateway does not implement as a JSON-RPC failure", async () => {
    const ctx = await boot();
    const response = await mcpRequest(
      ctx.gateway.app,
      ctx.config,
      "resources/list",
      {},
      ctx.token,
      {
        "user-agent": CHATGPT_AGENT,
      },
    );
    expect(response.status).toBe(200);

    const finished = lastEntry(ctx.logs, "mcp.response");
    expect(finished).toMatchObject({
      mcpMethod: "resources/list",
      httpStatus: 200,
      rpcErrorCode: -32601,
      rpcErrorMessage: "Method not found",
    });
    expect(
      ctx.logs.lines.some((line) => line.level === "error" && line.text.includes("-32601")),
    ).toBe(true);
  });

  it("logs upstream failures with status, error code, and stack", async () => {
    const ctx = await boot();
    ctx.mock.fail = true;
    await mcpRequest(ctx.gateway.app, ctx.config, "tools/list", {}, ctx.token, {
      "user-agent": CHATGPT_AGENT,
    });

    const upstream = lastEntry(ctx.logs, "agentmemory.list_tools.failed");
    expect(upstream).toMatchObject({
      upstreamStatus: 503,
      errorName: "AgentMemoryError",
      errorMessage: "Memory service is unavailable",
    });
    expect(String(upstream.stack)).toContain("AgentMemoryError");

    const bridge = lastEntry(ctx.logs, "mcp.tools_list_failed");
    expect(bridge).toMatchObject({ errorName: "AgentMemoryError" });

    const finished = lastEntry(ctx.logs, "mcp.response");
    expect(finished).toMatchObject({ mcpMethod: "tools/list", rpcErrorCode: -32603 });
    expect(ctx.logs.text()).not.toContain(BACKEND_SECRET);
    expect(ctx.logs.text()).not.toContain(ctx.config.agentmemoryUrl);
  });

  it("logs a rejected token as an error with the attempted MCP method", async () => {
    const ctx = await boot();
    const response = await mcpRequest(ctx.gateway.app, ctx.config, "tools/list", {}, undefined, {
      "user-agent": CHATGPT_AGENT,
    });
    expect(response.status).toBe(401);

    const finished = lastEntry(ctx.logs, "mcp.response");
    expect(finished).toMatchObject({ mcpMethod: "tools/list", httpStatus: 401 });
    expect(ctx.logs.lines.at(-1)?.level).toBe("error");
    expect(ctx.logs.text()).not.toContain(CLIENT_TOKEN);
  });

  it("never logs tokens, secrets, tool arguments, or tool results", async () => {
    const ctx = await boot();
    ctx.mock.callHandler = () =>
      Response.json({ content: [{ type: "text", text: "PRIVATE-MEMORY-CONTENT" }] });

    await mcpRequest(
      ctx.gateway.app,
      ctx.config,
      "tools/call",
      { name: "memory_save", arguments: { text: "PRIVATE-TOOL-ARGUMENT" } },
      ctx.token,
      { "user-agent": CHATGPT_AGENT },
    );

    // Guard against a vacuous assertion: the call must actually have been logged.
    expect(lastEntry(ctx.logs, "agentmemory.call_tool.succeeded")).toMatchObject({
      toolName: "memory_save",
      upstreamStatus: 200,
    });

    const captured = ctx.logs.text();
    for (const forbidden of [
      "PRIVATE-TOOL-ARGUMENT",
      "PRIVATE-MEMORY-CONTENT",
      ctx.token,
      CLIENT_TOKEN,
      BACKEND_SECRET,
      AUTH_SECRET,
      ADMIN_PASSWORD,
      "Bearer ",
      "authorization",
      "cookie",
    ]) {
      expect(captured).not.toContain(forbidden);
    }
  });
});
