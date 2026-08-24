import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { isAdminSubject } from "./auth.js";
import { toMcpToolError, type AgentMemoryClient, type AgentMemoryTool } from "./agentmemory.js";
import type { GatewayConfig } from "./config.js";
import { mcpToolError, TOOL_NOT_ALLOWED } from "./errors.js";
import {
  describeError,
  elapsedMs,
  logMcpEvent,
  summarizeMcpEnvelope,
  summarizeMcpResult,
  type McpEnvelopeSummary,
  type McpResultSummary,
} from "./mcp-log.js";

const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  memory_recall: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  memory_smart_search: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  memory_save: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

function withInteropMetadata(tool: AgentMemoryTool, resource: string): Record<string, unknown> {
  const annotations = {
    ...(TOOL_ANNOTATIONS[tool.name] ?? {}),
    ...tool.annotations,
  };
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: "object" },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations,
    securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
    _meta: {
      ...tool._meta,
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", resource).origin}/.well-known/oauth-protected-resource"`,
      ],
    },
  };
}

function createBridgeServer(client: AgentMemoryClient, resource: string): Server {
  const server = new Server(
    { name: "agentmemory-mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // The SDK turns a thrown handler error into a JSON-RPC error response without
  // reporting it, so log here or the cause never reaches stderr.
  server.onerror = (error) => {
    logMcpEvent("error", "mcp.server_error", describeError(error));
  };

  server.setRequestHandler("tools/list", async () => {
    try {
      const tools = await client.listTools();
      return {
        tools: tools.map((tool) => withInteropMetadata(tool, resource)) as Array<{
          name: string;
          inputSchema: { type: "object"; [key: string]: unknown };
        }>,
      };
    } catch (error) {
      logMcpEvent("error", "mcp.tools_list_failed", describeError(error));
      throw new Error(toMcpToolError(error).content[0]?.text ?? "Memory service is unavailable", {
        cause: error,
      });
    }
  });

  server.setRequestHandler("tools/call", async (request) => {
    const name = String(request.params.name ?? "");
    const args =
      request.params.arguments && typeof request.params.arguments === "object"
        ? (request.params.arguments as Record<string, unknown>)
        : {};

    if (!client.allowedTools.has(name)) {
      logMcpEvent("info", "mcp.tool_not_allowed", { toolName: name });
      return mcpToolError(TOOL_NOT_ALLOWED);
    }

    try {
      const result = await client.callTool(name, args);
      return {
        content: result.content as Array<{ type: "text"; text: string }>,
        ...(result.isError ? { isError: true } : {}),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result._meta ? { _meta: result._meta } : {}),
      };
    } catch (error) {
      logMcpEvent("error", "mcp.tool_call_failed", { toolName: name, ...describeError(error) });
      return toMcpToolError(error);
    }
  });

  return server;
}

function unauthorized(resource: string): Response {
  const metadata = `${new URL(resource).origin}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${metadata}", error="invalid_token"`,
      },
    },
  );
}

/** Reads the JSON-RPC method and id without consuming the forwarded request. */
async function peekEnvelope(request: Request): Promise<McpEnvelopeSummary> {
  if (request.method !== "POST") {
    return { envelope: "empty" };
  }
  try {
    return summarizeMcpEnvelope(await request.clone().text());
  } catch {
    return { envelope: "unparseable" };
  }
}

/**
 * A single MCP exchange produces one response and closes, so its body can be
 * buffered for diagnostics. `subscriptions/listen` stays open, so it is skipped.
 */
function inspectable(summary: McpEnvelopeSummary, response: Response): boolean {
  return (
    response.body !== null &&
    (summary.envelope === "request" || summary.envelope === "batch") &&
    summary.mcpMethod !== "subscriptions/listen"
  );
}

/**
 * Logs one line when an MCP exchange starts and one when it finishes, so Railway
 * shows which MCP operation a client ran and how it ended. Diagnostics read only
 * clones, so the client always receives exactly what the handler produced.
 */
export async function instrumentExchange(
  request: Request,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  const summary = await peekEnvelope(request);
  const context = {
    httpMethod: request.method,
    userAgent: request.headers.get("user-agent") ?? undefined,
    ...summary,
  };
  logMcpEvent("info", "mcp.request", context);

  let response: Response;
  try {
    response = await handle(request);
  } catch (error) {
    logMcpEvent("error", "mcp.exception", {
      ...context,
      durationMs: elapsedMs(startedAt),
      ...describeError(error),
    });
    throw error;
  }

  let result: McpResultSummary = {};
  if (inspectable(summary, response)) {
    try {
      result = summarizeMcpResult(await response.clone().text(), summary.mcpMethod);
    } catch (error) {
      logMcpEvent("error", "mcp.response_unreadable", { ...context, ...describeError(error) });
    }
  }

  const fields = {
    ...context,
    httpStatus: response.status,
    durationMs: elapsedMs(startedAt),
    ...result,
  };
  logMcpEvent(
    response.status >= 400 || result.rpcErrorCode !== undefined ? "error" : "info",
    "mcp.response",
    fields,
  );
  return response;
}

export function createMcpRouteHandler(input: {
  auth: Parameters<typeof requireMcpAuth>[0] & {
    api: unknown;
    handler: (request: Request) => Promise<Response>;
  };
  config: GatewayConfig;
  client: AgentMemoryClient;
  adminUserId: string;
}) {
  const handler = createMcpHandler(
    () => createBridgeServer(input.client, input.config.mcpResource),
    {
      // ChatGPT and Notion still speak the 2025 streamable-HTTP profile.
      // Better Auth's MCP 2026 profile can reject that; keep official SDK legacy support.
      legacy: "stateless",
      onerror: (error) => logMcpEvent("error", "mcp.sdk_error", describeError(error)),
    },
  );

  const authenticated = requireMcpAuth(
    input.auth,
    async (request: Request, claims: { sub?: unknown }) => {
      if (!isAdminSubject(input.adminUserId, claims.sub)) {
        logMcpEvent("error", "mcp.subject_rejected");
        return unauthorized(input.config.mcpResource);
      }
      return handler.fetch(request);
    },
    {
      resource: input.config.mcpResource,
      issuer: input.config.publicUrl,
      requiredScopes: ["mcp:tools"],
      challengeScopes: ["mcp:tools"],
    },
  );

  return (request: Request) => instrumentExchange(request, authenticated);
}
