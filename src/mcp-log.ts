import { redactValue } from "./security.js";

const MAX_TEXT_CHARS = 300;
const MAX_STACK_CHARS = 1500;
const MAX_LIST_ITEMS = 50;

/**
 * Field names that must never carry a value. `\bcode\b` blocks a bare `code`
 * field (an OAuth code) while leaving `rpcErrorCode` loggable.
 */
const BLOCKED_FIELD =
  /authorization|cookie|password|secret|token|\bcode\b|argument|param|payload|body|content|memory|header/i;

/**
 * Values a diagnostic field may hold. Objects are refused on purpose so a
 * request body, tool argument, or tool result can never reach a log line.
 */
export type McpLogField = string | number | boolean | readonly string[] | undefined;

function sanitizeText(value: string, max: number): string {
  const redacted = redactValue(value);
  return redacted.length > max ? `${redacted.slice(0, max)}...` : redacted;
}

function sanitizeField(key: string, value: Exclude<McpLogField, undefined>): unknown {
  if (BLOCKED_FIELD.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return sanitizeText(value, key === "stack" ? MAX_STACK_CHARS : MAX_TEXT_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_ITEMS).map((item) => sanitizeText(String(item), MAX_TEXT_CHARS));
  }
  return "[unsupported]";
}

/**
 * Writes one structured diagnostic line to stdout (`info`) or stderr (`error`)
 * so Railway shows MCP protocol activity, not just HTTP status codes.
 */
export function logMcpEvent(
  level: "info" | "error",
  event: string,
  fields: Record<string, McpLogField> = {},
): void {
  const entry: Record<string, unknown> = {
    log: "mcp",
    ts: new Date().toISOString(),
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      entry[key] = sanitizeField(key, value);
    }
  }
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** Safe error shape for a log line: names, messages, stack, and cause only. */
export function describeError(error: unknown): Record<string, McpLogField> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      causeMessage:
        error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : undefined,
    };
  }
  return { errorName: "NonError", errorMessage: String(error) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function methodOf(value: unknown): string | undefined {
  return isObject(value) && typeof value.method === "string" ? value.method : undefined;
}

function idOf(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return typeof value.id === "string" || typeof value.id === "number"
    ? String(value.id)
    : undefined;
}

export interface McpEnvelopeSummary {
  envelope: "request" | "notification" | "batch" | "response" | "empty" | "unparseable";
  mcpMethod?: string;
  mcpMethods?: string[];
  rpcId?: string;
  batchSize?: number;
}

/** Reads only the JSON-RPC method and id from a request body. Never `params`. */
export function summarizeMcpEnvelope(bodyText: string): McpEnvelopeSummary {
  if (bodyText.trim().length === 0) {
    return { envelope: "empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { envelope: "unparseable" };
  }
  if (Array.isArray(parsed)) {
    return {
      envelope: "batch",
      batchSize: parsed.length,
      mcpMethods: parsed.map((message) => methodOf(message) ?? "unknown"),
    };
  }
  const mcpMethod = methodOf(parsed);
  const rpcId = idOf(parsed);
  if (mcpMethod === undefined) {
    return { envelope: "response", rpcId };
  }
  return { envelope: rpcId === undefined ? "notification" : "request", mcpMethod, rpcId };
}

export interface McpResultSummary {
  rpcErrorCode?: number;
  rpcErrorMessage?: string;
  toolCount?: number;
  toolNames?: string[];
  protocolVersion?: string;
  capabilities?: string[];
  toolCallIsError?: boolean;
}

/** JSON-RPC payloads carried by a plain JSON body or an SSE `data:` frame. */
function jsonPayloads(bodyText: string): unknown[] {
  const frames = /^\s*[[{]/.test(bodyText)
    ? [bodyText]
    : bodyText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

  const payloads: unknown[] = [];
  for (const frame of frames) {
    try {
      const parsed: unknown = JSON.parse(frame);
      payloads.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // A partial or non-JSON frame carries nothing worth logging.
    }
  }
  return payloads;
}

/**
 * Reads the few safe fields a diagnostic needs out of an MCP response body:
 * JSON-RPC error code and message, the negotiated `initialize` handshake, and
 * `tools/list` names. Tool arguments, tool results, and memory contents are
 * never touched.
 */
export function summarizeMcpResult(
  bodyText: string,
  mcpMethod: string | undefined,
): McpResultSummary {
  const summary: McpResultSummary = {};
  for (const payload of jsonPayloads(bodyText)) {
    if (!isObject(payload)) {
      continue;
    }
    if (isObject(payload.error)) {
      if (typeof payload.error.code === "number") {
        summary.rpcErrorCode = payload.error.code;
      }
      if (typeof payload.error.message === "string") {
        summary.rpcErrorMessage = payload.error.message;
      }
    }
    if (!isObject(payload.result)) {
      continue;
    }
    const result = payload.result;
    if (mcpMethod === "initialize") {
      if (typeof result.protocolVersion === "string") {
        summary.protocolVersion = result.protocolVersion;
      }
      if (isObject(result.capabilities)) {
        summary.capabilities = Object.keys(result.capabilities);
      }
    }
    if (mcpMethod === "tools/list" && Array.isArray(result.tools)) {
      summary.toolCount = result.tools.length;
      summary.toolNames = result.tools.map((tool) =>
        isObject(tool) && typeof tool.name === "string" ? tool.name : "unnamed",
      );
    }
    if (mcpMethod === "tools/call" && typeof result.isError === "boolean") {
      summary.toolCallIsError = result.isError;
    }
  }
  return summary;
}
