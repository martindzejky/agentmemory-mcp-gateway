import {
  mcpToolError,
  TOOL_NOT_ALLOWED,
  UPSTREAM_INVALID,
  UPSTREAM_UNAVAILABLE,
} from "./errors.js";
import type { GatewayConfig } from "./config.js";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

export interface AgentMemoryTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface AgentMemoryContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AgentMemoryCallResult {
  content: AgentMemoryContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

export interface AgentMemoryRequestLog {
  url: string;
  method: string;
  authorizationHeader: string | null;
  forwardedClientAuthorization: boolean;
}

export interface AgentMemoryClient {
  listTools(): Promise<AgentMemoryTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<AgentMemoryCallResult>;
  allowedTools: ReadonlySet<string>;
}

function backendHeaders(secret: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${secret}`);
  headers.set("Accept", "application/json");
  return headers;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const raw = await response.arrayBuffer();
  if (raw.byteLength > MAX_UPSTREAM_BYTES) {
    throw new AgentMemoryError(UPSTREAM_INVALID);
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    throw new AgentMemoryError(UPSTREAM_INVALID);
  }
}

export class AgentMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMemoryError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTool(value: unknown): AgentMemoryTool | null {
  if (!isObject(value) || typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  const tool: AgentMemoryTool = { name: value.name };
  if (typeof value.description === "string") tool.description = value.description;
  if (typeof value.title === "string") tool.title = value.title;
  if (isObject(value.inputSchema)) tool.inputSchema = value.inputSchema;
  if (isObject(value.outputSchema)) tool.outputSchema = value.outputSchema;
  if (isObject(value.annotations)) tool.annotations = value.annotations;
  if (isObject(value._meta)) tool._meta = value._meta;
  return tool;
}

async function fetchUpstream(
  url: string,
  init: RequestInit,
  secret: string,
  requestLog?: AgentMemoryRequestLog[],
): Promise<Response> {
  const headers = backendHeaders(secret, init.headers);
  requestLog?.push({
    url,
    method: init.method ?? "GET",
    authorizationHeader: headers.get("Authorization"),
    forwardedClientAuthorization: false,
  });

  try {
    return await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new AgentMemoryError(UPSTREAM_UNAVAILABLE);
  }
}

export function createAgentMemoryClient(
  config: Pick<GatewayConfig, "agentmemoryUrl" | "agentmemorySecret" | "allowedTools">,
  options: { requestLog?: AgentMemoryRequestLog[] } = {},
): AgentMemoryClient {
  const allowedTools = new Set(config.allowedTools);

  return {
    allowedTools,
    async listTools() {
      const response = await fetchUpstream(
        `${config.agentmemoryUrl}/agentmemory/mcp/tools`,
        { method: "GET" },
        config.agentmemorySecret,
        options.requestLog,
      );
      if (!response.ok) {
        throw new AgentMemoryError(UPSTREAM_UNAVAILABLE);
      }
      const body = await readLimitedJson(response);
      const tools = isObject(body) && Array.isArray(body.tools) ? body.tools : null;
      if (!tools) {
        throw new AgentMemoryError(UPSTREAM_INVALID);
      }
      return tools
        .map(validateTool)
        .filter((tool): tool is AgentMemoryTool => tool !== null && allowedTools.has(tool.name));
    },
    async callTool(name, args) {
      if (!allowedTools.has(name)) {
        throw new AgentMemoryError(TOOL_NOT_ALLOWED);
      }
      const response = await fetchUpstream(
        `${config.agentmemoryUrl}/agentmemory/mcp/call`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, arguments: args }),
        },
        config.agentmemorySecret,
        options.requestLog,
      );
      if (!response.ok) {
        throw new AgentMemoryError(UPSTREAM_UNAVAILABLE);
      }
      const body = await readLimitedJson(response);
      if (!isObject(body)) {
        throw new AgentMemoryError(UPSTREAM_INVALID);
      }
      if (!Array.isArray(body.content) || !body.content.every(isObject)) {
        throw new AgentMemoryError(UPSTREAM_INVALID);
      }
      return {
        content: body.content as AgentMemoryContentBlock[],
        isError: body.isError === true,
        structuredContent: body.structuredContent,
        _meta: isObject(body._meta) ? body._meta : undefined,
      };
    },
  };
}

export function toMcpToolError(error: unknown): ReturnType<typeof mcpToolError> {
  if (error instanceof AgentMemoryError) {
    return mcpToolError(error.message);
  }
  return mcpToolError(UPSTREAM_UNAVAILABLE);
}
