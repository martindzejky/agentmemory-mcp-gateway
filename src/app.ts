import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createAgentMemoryClient, type AgentMemoryRequestLog } from "./agentmemory.js";
import { createGatewayAuth, isAdminSubject, type GatewayAuth } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import {
  createConsentCsrfToken,
  internalConsentHeaders,
  verifyConsentCsrfToken,
} from "./consent-csrf.js";
import { GENERIC_FORBIDDEN } from "./errors.js";
import { describeError, logMcpEvent } from "./mcp-log.js";
import { createMcpRouteHandler } from "./mcp.js";
import { consentPage, loginPage } from "./pages.js";
import {
  blockUserManagement,
  rateLimitSensitiveRoutes,
  safeLog,
  validateHost,
} from "./security.js";

export interface GatewayAppOptions {
  allowUserCreation?: boolean;
  requireSoleUser?: boolean;
  productionOriginChecks?: boolean;
  agentMemoryRequestLog?: AgentMemoryRequestLog[];
}

export interface GatewayApp {
  app: Hono;
  auth: GatewayAuth["auth"];
  db: GatewayAuth["db"];
  adminUserId: string | null;
  close(): void;
}

function queryString(url: URL): string {
  return url.search.startsWith("?") ? url.search.slice(1) : url.search;
}

/** Coarse reason for a rejected hosted consent POST. Never includes values. */
type ConsentRejection =
  "session_missing" | "csrf_missing" | "csrf_malformed" | "csrf_expired" | "csrf_invalid";

function denyConsent(c: Context, reason: ConsentRejection) {
  safeLog("hosted consent rejected", { reason });
  return c.json({ error: GENERIC_FORBIDDEN }, 403);
}

function cookieHeader(headers: Headers): string | null {
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
  }
  return headers.get("set-cookie");
}

export async function createGatewayApp(
  config: GatewayConfig,
  options: GatewayAppOptions = {},
): Promise<GatewayApp> {
  const gatewayAuth = await createGatewayAuth(config, {
    allowUserCreation: options.allowUserCreation,
    requireSoleUser: options.requireSoleUser,
    productionOriginChecks: options.productionOriginChecks,
  });
  const client = createAgentMemoryClient(config, { requestLog: options.agentMemoryRequestLog });
  const mcpHandler =
    gatewayAuth.adminUser &&
    createMcpRouteHandler({
      auth: gatewayAuth.auth,
      config,
      client,
      adminUserId: gatewayAuth.adminUser.id,
    });

  const app = new Hono();

  app.use("*", secureHeaders());
  app.use("*", validateHost(config));
  app.use("*", blockUserManagement());
  app.use("*", rateLimitSensitiveRoutes(config));
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );

  const corsOptions = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "MCP-Protocol-Version",
      "mcp-protocol-version",
      "mcp-session-id",
    ],
    exposeHeaders: ["WWW-Authenticate", "mcp-session-id"],
    maxAge: 600,
  };
  app.use("/.well-known/*", cors(corsOptions));
  app.use("/oauth2/*", cors(corsOptions));
  app.use("/jwks", cors(corsOptions));
  app.use("/mcp", cors(corsOptions));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/sign-in", (c) => {
    return c.html(loginPage(queryString(new URL(c.req.url)), c.req.query("error") === "1"));
  });

  app.post("/sign-in", async (c) => {
    const url = new URL(c.req.url);
    const form = await c.req.parseBody();
    const email = typeof form.email === "string" ? form.email : "";
    const password = typeof form.password === "string" ? form.password : "";
    try {
      const result = await gatewayAuth.auth.api.signInEmail({
        body: { email, password },
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      if (!isAdminSubject(gatewayAuth.adminUser?.id ?? "", result.response.user.id)) {
        return c.redirect(`/sign-in?${queryString(url)}&error=1`, 303);
      }
      const location = `/oauth2/authorize?${queryString(url)}`;
      const headers = new Headers({ Location: location });
      const cookies = cookieHeader(result.headers);
      if (cookies) {
        for (const cookie of result.headers.getSetCookie?.() ?? [cookies]) {
          headers.append("Set-Cookie", cookie);
        }
      }
      return new Response(null, { status: 303, headers });
    } catch {
      return c.redirect(`/sign-in?${queryString(url)}&error=1`, 303);
    }
  });

  app.get("/consent", async (c) => {
    const query = queryString(new URL(c.req.url));
    const session = await gatewayAuth.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.redirect(`/sign-in?${query}`, 303);
    }
    return c.html(
      consentPage({
        query,
        clientId: c.req.query("client_id") ?? "",
        scope: c.req.query("scope") ?? "",
        csrf: createConsentCsrfToken({
          secret: config.betterAuthSecret,
          sessionId: session.session.id,
          oauthQuery: query,
        }),
      }),
    );
  });

  app.post("/consent", async (c) => {
    const url = new URL(c.req.url);
    const oauthQuery = queryString(url);
    const session = await gatewayAuth.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return denyConsent(c, "session_missing");
    }
    const form = await c.req.parseBody();
    const token = typeof form.csrf === "string" ? form.csrf.trim() : "";
    if (!token) {
      return denyConsent(c, "csrf_missing");
    }
    const csrf = verifyConsentCsrfToken({
      secret: config.betterAuthSecret,
      sessionId: session.session.id,
      oauthQuery,
      token,
    });
    if (csrf !== "valid") {
      return denyConsent(c, `csrf_${csrf}`);
    }
    const accept = form.accept === "true";
    const response = await gatewayAuth.auth.handler(
      new Request(new URL("/oauth2/consent", config.publicUrl), {
        method: "POST",
        headers: internalConsentHeaders(c.req.header("cookie") ?? null, config.publicOrigin),
        body: JSON.stringify({
          accept,
          scope: url.searchParams.get("scope") ?? undefined,
          oauth_query: oauthQuery || undefined,
        }),
      }),
    );
    if (response.headers.get("location")) {
      return response;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("application/json")) {
      const body = (await response.json()) as {
        redirect?: boolean;
        url?: string;
        redirect_uri?: string;
      };
      const target = body.url ?? body.redirect_uri;
      if (typeof target === "string" && /^https?:\/\//.test(target)) {
        return c.redirect(target, 303);
      }
    }
    return response;
  });

  app.all("/mcp", async (c) => {
    if (!mcpHandler || !gatewayAuth.adminUser) {
      return c.json({ error: GENERIC_FORBIDDEN }, 503);
    }
    return mcpHandler(c.req.raw);
  });

  app.all("/*", (c) => gatewayAuth.auth.handler(c.req.raw));

  app.onError((error, c) => {
    if (c.req.path === "/sign-in") {
      return c.html(loginPage(queryString(new URL(c.req.url)), true), 401);
    }
    logMcpEvent("error", "gateway.unhandled_error", {
      path: c.req.path,
      ...describeError(error),
    });
    return c.json({ error: GENERIC_FORBIDDEN }, 500);
  });

  return {
    app,
    auth: gatewayAuth.auth,
    db: gatewayAuth.db,
    adminUserId: gatewayAuth.adminUser?.id ?? null,
    close() {
      gatewayAuth.db.close();
    },
  };
}
