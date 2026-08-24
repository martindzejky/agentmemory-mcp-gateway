import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { seedAdmin } from "../src/seed-admin.js";
import { resetRateLimits } from "../src/security.js";

export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "abcdefghijklmnopqrstuvwxyz";
export const AUTH_SECRET = "test-better-auth-secret-32-chars-minimum";
export const BACKEND_SECRET = "test-agentmemory-secret-32-chars-min";
export const CLIENT_TOKEN = "client-bearer-must-never-be-forwarded";

export interface MockAgentMemory {
  tools: unknown;
  callHandler?: (body: unknown, headers: Headers) => Response | Promise<Response>;
  calls: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
  fail: boolean;
}

export function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_URL: "http://127.0.0.1:8787",
    BETTER_AUTH_SECRET: AUTH_SECRET,
    DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "amg-")), "oauth.sqlite"),
    AGENTMEMORY_URL: "http://agentmemory.test:3111",
    AGENTMEMORY_SECRET: BACKEND_SECRET,
    ALLOWED_TOOLS: "memory_recall,memory_smart_search,memory_save",
    PORT: "8787",
    ...overrides,
  };
}

export function testConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  return {
    publicUrl: env.PUBLIC_URL!,
    publicOrigin: env.PUBLIC_URL!,
    publicHost: new URL(env.PUBLIC_URL!).host,
    mcpResource: `${env.PUBLIC_URL}/mcp`,
    betterAuthSecret: env.BETTER_AUTH_SECRET!,
    databasePath: env.DATABASE_PATH!,
    agentmemoryUrl: env.AGENTMEMORY_URL!,
    agentmemorySecret: env.AGENTMEMORY_SECRET!,
    allowedTools: (env.ALLOWED_TOOLS ?? "").split(","),
    port: Number(env.PORT ?? 8787),
    isProduction: false,
    trustedProxyHeaders: false,
  };
}

export function defaultTools() {
  return [
    {
      name: "memory_recall",
      description: "Recall memories",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "memory_smart_search",
      description: "Search memories",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "memory_save",
      description: "Save a memory",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "memory_export",
      description: "Export should be filtered out",
      inputSchema: { type: "object" },
    },
  ];
}

export function createMockAgentMemory(): MockAgentMemory {
  return {
    tools: { tools: defaultTools() },
    calls: [],
    fail: false,
  };
}

function headersFromInit(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

export function installFetchBridge(
  app: Hono,
  config: GatewayConfig,
  mock: MockAgentMemory,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);

    if (url.origin === config.publicOrigin) {
      const headers = new Headers(request.headers);
      if (!headers.has("host")) {
        headers.set("host", config.publicHost);
      }
      return app.request(`${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.clone().arrayBuffer(),
      });
    }

    if (url.origin === new URL(config.agentmemoryUrl).origin) {
      const bodyText = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
      const body = bodyText ? JSON.parse(bodyText) : null;
      mock.calls.push({
        url: url.href,
        method: request.method,
        headers: request.headers,
        body,
      });
      if (mock.fail) {
        return new Response("nope", { status: 503 });
      }
      if (url.pathname.endsWith("/agentmemory/mcp/tools")) {
        return Response.json(mock.tools);
      }
      if (url.pathname.endsWith("/agentmemory/mcp/call")) {
        if (mock.callHandler) {
          return mock.callHandler(body, request.headers);
        }
        return Response.json({
          content: [{ type: "text", text: "recalled" }],
        });
      }
      return new Response("not found", { status: 404 });
    }

    throw new Error(`Unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

export async function request(
  app: Hono,
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const headers = headersFromInit(init);
  headers.set("host", init.host ?? "127.0.0.1:8787");
  return app.request(path, { ...init, headers });
}

export function collectCookies(response: Response, previous = ""): string {
  const next = new Map(
    previous
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...rest] = part.split("=");
        return [name ?? "", rest.join("=")];
      }),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = pair?.split("=") ?? [];
    if (name) {
      next.set(name, rest.join("="));
    }
  }
  return [...next.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function startGateway(
  options: {
    env?: NodeJS.ProcessEnv;
    seed?: boolean;
    mock?: MockAgentMemory;
    trustedProxyHeaders?: boolean;
    productionOriginChecks?: boolean;
  } = {},
): Promise<{
  env: NodeJS.ProcessEnv;
  config: GatewayConfig;
  gateway: GatewayApp;
  mock: MockAgentMemory;
  restoreFetch: () => void;
}> {
  resetRateLimits();
  const env = options.env ?? baseEnv();
  if (options.seed !== false) {
    await seedAdmin({
      ...env,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    });
  }
  const config = {
    ...testConfig(env),
    trustedProxyHeaders: options.trustedProxyHeaders === true,
  };
  const mock = options.mock ?? createMockAgentMemory();
  const gateway = await createGatewayApp(config, {
    requireSoleUser: options.seed !== false,
    productionOriginChecks: options.productionOriginChecks,
    agentMemoryRequestLog: [],
  });
  const restoreFetch = installFetchBridge(gateway.app, config, mock);
  return { env, config, gateway, mock, restoreFetch };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function registerClient(
  app: Hono,
  config: GatewayConfig,
): Promise<{ client_id: string }> {
  const response = await request(app, "/oauth2/register", {
    method: "POST",
    host: config.publicHost,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test-client",
      redirect_uris: ["http://localhost/callback"],
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!response.ok) {
    throw new Error(`DCR failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { client_id: string };
}

export async function signIn(app: Hono, config: GatewayConfig, query = ""): Promise<string> {
  const body = new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const response = await request(app, `/sign-in${query ? `?${query}` : ""}`, {
    method: "POST",
    host: config.publicHost,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  return collectCookies(response);
}

export function extractConsentCsrf(html: string): string {
  return html.match(/name="csrf" value="([^"]*)"/)?.[1] ?? "";
}

export function extractConsentCsrfFields(html: string): string[] {
  return [...html.matchAll(/name="csrf" value="([^"]*)"/g)].map((match) => match[1] ?? "");
}

export async function currentSessionId(gateway: GatewayApp, cookies: string): Promise<string> {
  const session = await gateway.auth.api.getSession({ headers: new Headers({ cookie: cookies }) });
  if (!session) {
    throw new Error("Expected an authenticated session");
  }
  return session.session.id;
}

export async function prepareConsentFlow(
  app: Hono,
  config: GatewayConfig,
): Promise<{
  clientId: string;
  verifier: string;
  cookies: string;
  consentPath: string;
  consentQuery: string;
  csrf: string;
}> {
  const client = await registerClient(app, config);
  const { verifier, challenge } = pkce();
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost/callback",
    scope: "openid profile offline_access mcp:tools",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: config.mcpResource,
    state: "test-state",
  });

  let cookies = await signIn(app, config, authorizeQuery.toString());
  let location: string | null = `/oauth2/authorize?${authorizeQuery}`;

  for (let i = 0; i < 8 && location; i += 1) {
    const current = new URL(location, config.publicUrl);
    if (current.pathname === "/consent") {
      const consentPath = `${current.pathname}${current.search}`;
      const consentQuery = current.search.startsWith("?")
        ? current.search.slice(1)
        : current.search;
      const page = await request(app, consentPath, {
        method: "GET",
        host: config.publicHost,
        headers: { cookie: cookies },
        redirect: "manual",
      });
      cookies = collectCookies(page, cookies);
      return {
        clientId: client.client_id,
        verifier,
        cookies,
        consentPath,
        consentQuery,
        csrf: extractConsentCsrf(await page.text()),
      };
    }
    const response = await request(app, `${current.pathname}${current.search}`, {
      method: "GET",
      host: config.publicHost,
      headers: { cookie: cookies },
      redirect: "manual",
    });
    cookies = collectCookies(response, cookies);
    location = response.headers.get("location");
    if (location?.startsWith("http://localhost/callback") || location?.includes("/callback?")) {
      throw new Error(`Reached client callback before consent: ${location}`);
    }
  }

  throw new Error("Unable to reach the consent screen");
}

export async function postConsent(
  app: Hono,
  config: GatewayConfig,
  input: {
    path: string;
    cookies: string;
    accept: boolean;
    headers?: HeadersInit;
    csrf?: string;
  },
): Promise<Response> {
  const headers = new Headers(input.headers);
  headers.set("cookie", input.cookies);
  headers.set("content-type", "application/x-www-form-urlencoded");
  const body = new URLSearchParams({ accept: String(input.accept) });
  if (input.csrf) {
    body.set("csrf", input.csrf);
  }
  return request(app, input.path, {
    method: "POST",
    host: config.publicHost,
    headers,
    body,
    redirect: "manual",
  });
}

export function callbackLocation(response: Response): URL | null {
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }
  if (location.startsWith("http://localhost/callback") || location.includes("/callback?")) {
    return new URL(location, "http://localhost");
  }
  return null;
}

export async function exchangeAuthorizationCode(
  app: Hono,
  config: GatewayConfig,
  input: { code: string; clientId: string; verifier: string },
): Promise<Response> {
  return request(app, "/oauth2/token", {
    method: "POST",
    host: config.publicHost,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: "http://localhost/callback",
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: config.mcpResource,
    }),
  });
}

export async function getAccessToken(app: Hono, config: GatewayConfig): Promise<string> {
  const client = await registerClient(app, config);
  const { verifier, challenge } = pkce();
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost/callback",
    scope: "openid profile offline_access mcp:tools",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: config.mcpResource,
    state: "test-state",
  });

  let cookies = await signIn(app, config, authorizeQuery.toString());
  let location: string | null = `/oauth2/authorize?${authorizeQuery}`;
  let csrf = "";
  const trace: string[] = [];

  for (let i = 0; i < 8 && location; i += 1) {
    const current: URL = new URL(location, config.publicUrl);
    const method = current.pathname === "/consent" && csrf ? "POST" : "GET";
    const response = await request(app, `${current.pathname}${current.search}`, {
      method,
      host: config.publicHost,
      headers: {
        cookie: cookies,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? new URLSearchParams({ accept: "true", csrf }) : undefined,
      redirect: "manual",
    });
    cookies = collectCookies(response, cookies);
    let nextLocation = response.headers.get("location");
    const preview = await response.clone().text();
    if (method === "GET" && current.pathname === "/consent") {
      csrf = extractConsentCsrf(preview);
      if (csrf && !nextLocation) {
        nextLocation = `${current.pathname}${current.search}`;
      }
    }
    if (!nextLocation && preview.includes("http://localhost/callback")) {
      try {
        const body = JSON.parse(preview) as { url?: string; redirect_uri?: string };
        nextLocation = body.url ?? body.redirect_uri ?? null;
      } catch {
        nextLocation = null;
      }
    }
    trace.push(
      `${method} ${current.pathname} -> ${response.status} ${nextLocation ?? preview.slice(0, 200)}`,
    );
    location = nextLocation;

    if (location?.startsWith("http://localhost/callback") || location?.includes("/callback?")) {
      const target = new URL(location, "http://localhost");
      const code = target.searchParams.get("code");
      if (!code) {
        throw new Error(`Authorization redirect omitted code: ${location}\n${trace.join("\n")}`);
      }
      const tokenResponse = await request(app, "/oauth2/token", {
        method: "POST",
        host: config.publicHost,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost/callback",
          client_id: client.client_id,
          code_verifier: verifier,
          resource: config.mcpResource,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error(
          `Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}\n${trace.join("\n")}`,
        );
      }
      const tokens = (await tokenResponse.json()) as { access_token: string };
      return tokens.access_token;
    }
  }

  throw new Error(`Unable to complete OAuth authorization in tests\n${trace.join("\n")}`);
}

export async function mcpRequest(
  app: Hono,
  config: GatewayConfig,
  method: string,
  params: Record<string, unknown> = {},
  accessToken?: string,
) {
  return request(app, "/mcp", {
    method: "POST",
    host: config.publicHost,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : { authorization: `Bearer ${CLIENT_TOKEN}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
