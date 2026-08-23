const DEFAULT_ALLOWED_TOOLS = ["memory_recall", "memory_smart_search", "memory_save"] as const;
const DEFAULT_PORT = 8080;
const MIN_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 20;

export type GatewayMode = "runtime" | "seed";

export interface GatewayConfig {
  publicUrl: string;
  publicOrigin: string;
  publicHost: string;
  mcpResource: string;
  betterAuthSecret: string;
  databasePath: string;
  agentmemoryUrl: string;
  agentmemorySecret: string;
  allowedTools: readonly string[];
  port: number;
  isProduction: boolean;
  trustedProxyHeaders: boolean;
}

export interface SeedConfig extends GatewayConfig {
  adminEmail: string;
  adminPassword: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new ConfigError(`${name} is required`);
  }
  return trimmed;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function normalizePublicUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("PUBLIC_URL must be an absolute URL");
  }

  if (parsed.username || parsed.password) {
    throw new ConfigError("PUBLIC_URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigError("PUBLIC_URL must not contain a query or fragment");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    throw new ConfigError("PUBLIC_URL must use HTTPS except on loopback hosts");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (parsed.pathname !== "/") {
    throw new ConfigError("PUBLIC_URL must be an origin with no path");
  }

  return parsed;
}

function normalizeAgentmemoryUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("AGENTMEMORY_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError("AGENTMEMORY_URL must not contain credentials");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("AGENTMEMORY_URL must use HTTP or HTTPS");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function parseAllowedTools(raw: string | undefined): string[] {
  const tools = (raw ?? DEFAULT_ALLOWED_TOOLS.join(","))
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.length === 0) {
    throw new ConfigError("ALLOWED_TOOLS must list at least one tool");
  }
  if (new Set(tools).size !== tools.length) {
    throw new ConfigError("ALLOWED_TOOLS must not contain duplicates");
  }
  return tools;
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
  }
  return value;
}

function assertSecret(name: string, value: string): void {
  if (value.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const publicUrl = normalizePublicUrl(required("PUBLIC_URL", env.PUBLIC_URL));
  const betterAuthSecret = required("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  const agentmemorySecret = required("AGENTMEMORY_SECRET", env.AGENTMEMORY_SECRET);
  assertSecret("BETTER_AUTH_SECRET", betterAuthSecret);
  assertSecret("AGENTMEMORY_SECRET", agentmemorySecret);

  const isProduction = env.NODE_ENV === "production";
  if (isProduction && publicUrl.protocol !== "https:") {
    throw new ConfigError("PUBLIC_URL must use HTTPS in production");
  }

  return {
    publicUrl: publicUrl.origin,
    publicOrigin: publicUrl.origin,
    publicHost: publicUrl.host,
    mcpResource: `${publicUrl.origin}/mcp`,
    betterAuthSecret,
    databasePath: required("DATABASE_PATH", env.DATABASE_PATH),
    agentmemoryUrl: normalizeAgentmemoryUrl(required("AGENTMEMORY_URL", env.AGENTMEMORY_URL)),
    agentmemorySecret,
    allowedTools: parseAllowedTools(env.ALLOWED_TOOLS),
    port: parsePort(env.PORT),
    isProduction,
    trustedProxyHeaders: isProduction || env.TRUST_PROXY === "1",
  };
}

export function loadSeedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const config = loadGatewayConfig(env);
  const adminEmail = required("ADMIN_EMAIL", env.ADMIN_EMAIL).toLowerCase();
  const adminPassword = required("ADMIN_PASSWORD", env.ADMIN_PASSWORD);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new ConfigError("ADMIN_EMAIL must be a valid email address");
  }
  if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new ConfigError(
      `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
    );
  }

  return { ...config, adminEmail, adminPassword };
}

export const DEFAULT_TOOL_ALLOWLIST = DEFAULT_ALLOWED_TOOLS;
