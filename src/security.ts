import type { Context, MiddlewareHandler } from "hono";
import { GENERIC_FORBIDDEN } from "./errors.js";
import type { GatewayConfig } from "./config.js";

const BLOCKED_PATH_PREFIXES = [
  "/sign-up",
  "/api/auth/sign-up",
  "/request-password-reset",
  "/reset-password",
  "/forget-password",
  "/change-password",
  "/change-email",
  "/delete-user",
  "/admin",
  "/api/auth/admin",
];

const RATE_LIMITED_PATHS: Array<{ prefix: string; limit: number; windowMs: number }> = [
  { prefix: "/sign-in", limit: 10, windowMs: 60_000 },
  { prefix: "/oauth2/token", limit: 30, windowMs: 60_000 },
  { prefix: "/oauth2/register", limit: 10, windowMs: 60_000 },
];

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

export function resetRateLimits(): void {
  buckets.clear();
}

function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return c.req.header("x-real-ip") || "unknown";
}

export function isBlockedUserManagementPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return BLOCKED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function blockUserManagement(): MiddlewareHandler {
  return async (c, next) => {
    if (isBlockedUserManagementPath(c.req.path)) {
      return c.json({ error: GENERIC_FORBIDDEN }, 403);
    }
    return next();
  };
}

export function rateLimitSensitiveRoutes(): MiddlewareHandler {
  return async (c, next) => {
    const rule = RATE_LIMITED_PATHS.find(
      (item) => c.req.path === item.prefix || c.req.path.startsWith(`${item.prefix}/`),
    );
    if (!rule) {
      return next();
    }
    const key = `${clientKey(c)}:${rule.prefix}`;
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return next();
    }
    if (current.count >= rule.limit) {
      return c.json({ error: "Too many requests" }, 429);
    }
    current.count += 1;
    return next();
  };
}

export function validateHost(config: GatewayConfig): MiddlewareHandler {
  const allowed = new Set([
    config.publicHost,
    `localhost:${config.port}`,
    `127.0.0.1:${config.port}`,
  ]);
  return async (c, next) => {
    if (c.req.path === "/healthz") {
      return next();
    }
    const host = c.req.header("host");
    if (!host || !allowed.has(host)) {
      return c.json({ error: GENERIC_FORBIDDEN }, 403);
    }
    return next();
  };
}

const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;
const SENSITIVE_VALUE =
  /(bearer\s+[a-z0-9._~+/-]+=*|password|client_secret|authorization_code|refresh_token|access_token)/i;

export function redactValue(value: string): string {
  if (SENSITIVE_VALUE.test(value)) {
    return "[redacted]";
  }
  return value;
}

export function safeLog(message: string, extra?: Record<string, unknown>): void {
  const sanitized = extra
    ? Object.fromEntries(
        Object.entries(extra).map(([key, value]) => {
          if (SENSITIVE_HEADER.test(key) || /password|secret|token|code/i.test(key)) {
            return [key, "[redacted]"];
          }
          return [key, typeof value === "string" ? redactValue(value) : value];
        }),
      )
    : undefined;
  if (sanitized) {
    console.info(message, sanitized);
  } else {
    console.info(message);
  }
}

export function containsSecret(haystack: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && haystack.includes(secret));
}
