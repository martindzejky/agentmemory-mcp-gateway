import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_CSRF_TTL_SECONDS,
  createConsentCsrfToken,
  internalConsentHeaders,
  verifyConsentCsrfToken,
} from "../src/consent-csrf.js";
import { GENERIC_FORBIDDEN } from "../src/errors.js";
import {
  callbackLocation,
  currentSessionId,
  exchangeAuthorizationCode,
  extractConsentCsrfFields,
  postConsent,
  prepareConsentFlow,
  request,
  startGateway,
  type startGateway as StartGateway,
} from "./helpers.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:8787";
const CSRF_SECRET = "test-better-auth-secret-32-chars-minimum";
const QUERY = "client_id=abc&scope=openid";

/** Header shape observed from Safari's hosted authentication window. */
const SAFARI_AUTH_WINDOW_HEADERS = {
  origin: "null",
  referer: "https://chatgpt.com/",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  restore?.();
  close?.();
  restore = undefined;
  close = undefined;
  vi.restoreAllMocks();
});

async function boot(options?: Parameters<typeof StartGateway>[0]) {
  const ctx = await startGateway({ productionOriginChecks: true, ...options });
  restore = ctx.restoreFetch;
  close = () => ctx.gateway.close();
  return ctx;
}

function forge(token: string): string {
  const [exp, signature] = token.split(".");
  const flipped = signature?.startsWith("a")
    ? `b${signature.slice(1)}`
    : `a${(signature ?? "").slice(1)}`;
  return `${exp}.${flipped}`;
}

describe("consent CSRF token", () => {
  it("accepts a token bound to the session and oauth query", () => {
    const token = createConsentCsrfToken({
      secret: CSRF_SECRET,
      sessionId: "session-1",
      oauthQuery: QUERY,
    });
    expect(
      verifyConsentCsrfToken({
        secret: CSRF_SECRET,
        sessionId: "session-1",
        oauthQuery: QUERY,
        token,
      }),
    ).toBe("valid");
  });

  it("rejects a token minted for another session or another oauth query", () => {
    const token = createConsentCsrfToken({
      secret: CSRF_SECRET,
      sessionId: "session-1",
      oauthQuery: QUERY,
    });
    expect(
      verifyConsentCsrfToken({
        secret: CSRF_SECRET,
        sessionId: "session-2",
        oauthQuery: QUERY,
        token,
      }),
    ).toBe("invalid");
    expect(
      verifyConsentCsrfToken({
        secret: CSRF_SECRET,
        sessionId: "session-1",
        oauthQuery: "client_id=tampered&scope=openid",
        token,
      }),
    ).toBe("invalid");
  });

  it("rejects a forged signature and a token signed with another secret", () => {
    const token = createConsentCsrfToken({
      secret: CSRF_SECRET,
      sessionId: "session-1",
      oauthQuery: QUERY,
    });
    const base = { secret: CSRF_SECRET, sessionId: "session-1", oauthQuery: QUERY };
    expect(verifyConsentCsrfToken({ ...base, token: forge(token) })).toBe("invalid");
    expect(
      verifyConsentCsrfToken({
        ...base,
        token: createConsentCsrfToken({
          secret: "another-secret-32-characters-minimum",
          sessionId: "session-1",
          oauthQuery: QUERY,
        }),
      }),
    ).toBe("invalid");
  });

  it("rejects an expired token", () => {
    const token = createConsentCsrfToken({
      secret: CSRF_SECRET,
      sessionId: "session-1",
      oauthQuery: QUERY,
      nowMs: Date.now() - (CONSENT_CSRF_TTL_SECONDS + 5) * 1000,
    });
    expect(
      verifyConsentCsrfToken({
        secret: CSRF_SECRET,
        sessionId: "session-1",
        oauthQuery: QUERY,
        token,
      }),
    ).toBe("expired");
  });

  it("rejects malformed tokens", () => {
    const base = { secret: CSRF_SECRET, sessionId: "session-1", oauthQuery: QUERY };
    for (const token of ["", "not-a-token", "1700000000.", ".abc", "abc.def"]) {
      expect(verifyConsentCsrfToken({ ...base, token })).toBe("malformed");
    }
  });
});

describe("internalConsentHeaders", () => {
  it("pins the configured origin and relays only the session cookie", () => {
    const headers = internalConsentHeaders("better-auth.session=1", PUBLIC_ORIGIN);
    expect(headers.get("origin")).toBe(PUBLIC_ORIGIN);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBe("better-auth.session=1");
    expect([...headers.keys()].sort()).toEqual(["content-type", "cookie", "origin"]);
  });

  it("omits the cookie header when the request had none", () => {
    const headers = internalConsentHeaders(null, PUBLIC_ORIGIN);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("origin")).toBe(PUBLIC_ORIGIN);
  });
});

describe("hosted consent with production origin checks", () => {
  it("completes authorization when the POST omits Origin and sends a valid token", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    expect(flow.csrf).toMatch(/\S/);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      csrf: flow.csrf,
    });
    const callback = callbackLocation(response);
    expect(callback?.searchParams.get("code")).toMatch(/\S/);
    expect(callback?.searchParams.get("state")).toBe("test-state");
  });

  it("completes authorization when Safari sends Origin: null", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: { origin: "null" },
      csrf: flow.csrf,
    });
    expect(callbackLocation(response)?.searchParams.get("code")).toMatch(/\S/);
  });

  it("completes authorization from a Safari authentication window with foreign metadata", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: SAFARI_AUTH_WINDOW_HEADERS,
      csrf: flow.csrf,
    });
    expect(callbackLocation(response)?.searchParams.get("code")).toMatch(/\S/);
  });

  it("completes authorization with a foreign Origin because the token is the proof", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      csrf: flow.csrf,
    });
    expect(callbackLocation(response)?.searchParams.get("code")).toMatch(/\S/);
  });

  it("rejects matching same-origin headers when no token is submitted", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: {
        origin: config.publicOrigin,
        referer: `${config.publicOrigin}${flow.consentPath}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
    expect(callbackLocation(response)).toBeNull();
  });

  it("rejects a missing, malformed, or forged token", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    for (const csrf of [undefined, "not-a-token", forge(flow.csrf)]) {
      const response = await postConsent(gateway.app, config, {
        path: flow.consentPath,
        cookies: flow.cookies,
        accept: true,
        csrf,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
      expect(callbackLocation(response)).toBeNull();
    }
  });

  it("rejects expired, wrong-session, and wrong-query tokens", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const sessionId = await currentSessionId(gateway, flow.cookies);
    const tokens = [
      createConsentCsrfToken({
        secret: config.betterAuthSecret,
        sessionId,
        oauthQuery: flow.consentQuery,
        nowMs: Date.now() - (CONSENT_CSRF_TTL_SECONDS + 5) * 1000,
      }),
      createConsentCsrfToken({
        secret: config.betterAuthSecret,
        sessionId: "another-session",
        oauthQuery: flow.consentQuery,
      }),
      createConsentCsrfToken({
        secret: config.betterAuthSecret,
        sessionId,
        oauthQuery: `${flow.consentQuery}&extra=1`,
      }),
    ];
    for (const csrf of tokens) {
      const response = await postConsent(gateway.app, config, {
        path: flow.consentPath,
        cookies: flow.cookies,
        accept: true,
        csrf,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
    }
  });

  it("rejects a submission with no session cookie", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: "",
      accept: true,
      headers: { origin: config.publicOrigin },
      csrf: flow.csrf,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
  });

  it("rejects a tampered signed OAuth query without leaking signing material", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const tampered = new URLSearchParams(flow.consentQuery);
    tampered.set("client_id", "tampered-client");
    const response = await postConsent(gateway.app, config, {
      path: `/consent?${tampered}`,
      cookies: flow.cookies,
      accept: true,
      csrf: flow.csrf,
    });
    expect(response.status).toBe(403);
    expect(callbackLocation(response)).toBeNull();
    const body = await response.text();
    expect(body).toContain(GENERIC_FORBIDDEN);
    expect(body).not.toContain(config.betterAuthSecret);
    expect(body).not.toMatch(/sig=/i);
  });

  it("logs a coarse reason without the submitted token", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      csrf: forge(flow.csrf),
    });
    expect(info).toHaveBeenCalledWith("hosted consent rejected", { reason: "csrf_invalid" });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(flow.csrf);
    expect(logged).not.toContain(flow.consentQuery);
    expect(logged).not.toContain(config.betterAuthSecret);
  });

  it("does not expose a usable token without an authenticated session", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const page = await request(gateway.app, flow.consentPath, {
      method: "GET",
      host: config.publicHost,
      redirect: "manual",
    });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/sign-in?${flow.consentQuery}`);
    expect(extractConsentCsrfFields(await page.text())).toEqual([]);
  });

  it("puts the same token in both the Allow and Deny forms", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const page = await request(gateway.app, flow.consentPath, {
      method: "GET",
      host: config.publicHost,
      headers: { cookie: flow.cookies },
      redirect: "manual",
    });
    const html = await page.text();
    const fields = extractConsentCsrfFields(html);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatch(/\S/);
    expect(fields[1]).toBe(fields[0]);
    expect(html).toContain('name="accept" value="true"');
    expect(html).toContain('name="accept" value="false"');
  });

  it("returns the OAuth denial redirect when consent is denied", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: false,
      csrf: flow.csrf,
    });
    const callback = callbackLocation(response);
    expect(callback?.searchParams.get("error")).toBe("access_denied");
    expect(callback?.searchParams.get("code")).toBeNull();
    expect(callback?.searchParams.get("state")).toBe("test-state");
  });

  it("completes DCR, login, consent, PKCE, and token exchange", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const consent = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      csrf: flow.csrf,
    });
    const code = callbackLocation(consent)?.searchParams.get("code");
    expect(code).toMatch(/\S/);
    const tokenResponse = await exchangeAuthorizationCode(gateway.app, config, {
      code: code!,
      clientId: flow.clientId,
      verifier: flow.verifier,
    });
    expect(tokenResponse.ok).toBe(true);
    const tokens = (await tokenResponse.json()) as { access_token?: string; token_type?: string };
    expect(tokens.access_token).toMatch(/\S/);
    expect(tokens.token_type?.toLowerCase()).toBe("bearer");
    expect(JSON.stringify(tokens)).not.toContain(config.betterAuthSecret);
  });

  it("still rejects a direct /oauth2/consent POST that omits Origin", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await request(gateway.app, "/oauth2/consent", {
      method: "POST",
      host: config.publicHost,
      headers: { cookie: flow.cookies, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: flow.consentQuery }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("MISSING_OR_NULL_ORIGIN");
    expect(body.message).toMatch(/origin/i);
  });

  it("still rejects a direct /oauth2/consent POST without a session", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await request(gateway.app, "/oauth2/consent", {
      method: "POST",
      host: config.publicHost,
      headers: { origin: config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: flow.consentQuery }),
      redirect: "manual",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(callbackLocation(response)).toBeNull();
  });
});
