import { afterEach, describe, expect, it } from "vitest";
import { GENERIC_FORBIDDEN } from "../src/errors.js";
import {
  isTrustedConsentSubmission,
  trustedInternalConsentHeaders,
} from "../src/consent-origin.js";
import {
  callbackLocation,
  exchangeAuthorizationCode,
  postConsent,
  prepareConsentFlow,
  request,
  startGateway,
  type startGateway as StartGateway,
} from "./helpers.js";

const PUBLIC_ORIGIN = "http://127.0.0.1:8787";

let restore: (() => void) | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  restore?.();
  close?.();
  restore = undefined;
  close = undefined;
});

async function boot(options?: Parameters<typeof StartGateway>[0]) {
  const ctx = await startGateway({ productionOriginChecks: true, ...options });
  restore = ctx.restoreFetch;
  close = () => ctx.gateway.close();
  return ctx;
}

function headers(init?: HeadersInit): Headers {
  return new Headers(init);
}

describe("isTrustedConsentSubmission", () => {
  it("accepts a matching Origin", () => {
    expect(
      isTrustedConsentSubmission(
        headers({ origin: PUBLIC_ORIGIN, cookie: "better-auth.session=1" }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(true);
  });

  it("rejects a foreign Origin even when a session cookie is present", () => {
    expect(
      isTrustedConsentSubmission(
        headers({ origin: "https://evil.example", cookie: "better-auth.session=1" }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects Origin: null", () => {
    expect(
      isTrustedConsentSubmission(
        headers({ origin: "null", cookie: "better-auth.session=1" }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(false);
  });

  it("accepts a missing Origin with a same-origin Referer", () => {
    expect(
      isTrustedConsentSubmission(
        headers({
          referer: `${PUBLIC_ORIGIN}/consent?client_id=abc`,
          cookie: "better-auth.session=1",
        }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(true);
  });

  it("rejects a missing Origin with a foreign Referer", () => {
    expect(
      isTrustedConsentSubmission(
        headers({ referer: "https://chatgpt.com/", cookie: "better-auth.session=1" }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(false);
  });

  it("accepts a missing Origin with same-origin Fetch Metadata", () => {
    expect(
      isTrustedConsentSubmission(headers({ "sec-fetch-site": "same-origin" }), PUBLIC_ORIGIN),
    ).toBe(true);
  });

  it("rejects cross-site Fetch Metadata", () => {
    expect(
      isTrustedConsentSubmission(
        headers({
          "sec-fetch-site": "cross-site",
          cookie: "better-auth.session=1",
          origin: PUBLIC_ORIGIN,
        }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(false);
  });

  it("accepts a ChatGPT-style form POST with no Origin and a session cookie", () => {
    expect(
      isTrustedConsentSubmission(headers({ cookie: "better-auth.session=1" }), PUBLIC_ORIGIN),
    ).toBe(true);
  });

  it("rejects a request with no Origin, Referer, Fetch Metadata, or cookie", () => {
    expect(isTrustedConsentSubmission(headers(), PUBLIC_ORIGIN)).toBe(false);
  });

  it("does not treat credentialed or non-http origins as same-origin", () => {
    expect(
      isTrustedConsentSubmission(
        headers({ origin: `http://user@${new URL(PUBLIC_ORIGIN).host}` }),
        PUBLIC_ORIGIN,
      ),
    ).toBe(false);
    expect(
      isTrustedConsentSubmission(headers({ origin: "ftp://127.0.0.1:8787" }), PUBLIC_ORIGIN),
    ).toBe(false);
  });

  it("attaches the configured origin to the internal request", () => {
    const incoming = headers({
      cookie: "better-auth.session=1",
      origin: PUBLIC_ORIGIN,
      "content-length": "12",
    });
    const trusted = trustedInternalConsentHeaders(incoming, PUBLIC_ORIGIN);
    expect(trusted.get("origin")).toBe(PUBLIC_ORIGIN);
    expect(trusted.get("content-type")).toBe("application/json");
    expect(trusted.get("content-length")).toBeNull();
    expect(trusted.get("cookie")).toBe("better-auth.session=1");
  });
});

describe("hosted consent with production origin checks", () => {
  it("completes authorization when the consent POST omits Origin", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
    });
    const callback = callbackLocation(response);
    expect(callback).not.toBeNull();
    expect(callback?.searchParams.get("code")).toMatch(/\S/);
    expect(callback?.searchParams.get("state")).toBe("test-state");
  });

  it("completes authorization when Origin matches the configured public origin", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: { origin: config.publicOrigin },
    });
    expect(callbackLocation(response)?.searchParams.get("code")).toMatch(/\S/);
  });

  it("rejects a foreign Origin", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
    expect(callbackLocation(response)).toBeNull();
  });

  it("rejects Origin: null", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: true,
      headers: { origin: "null" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: GENERIC_FORBIDDEN });
  });

  it("rejects a tampered signed OAuth query", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const tampered = new URLSearchParams(flow.consentQuery);
    tampered.set("client_id", "tampered-client");
    const response = await postConsent(gateway.app, config, {
      path: `/consent?${tampered}`,
      cookies: flow.cookies,
      accept: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(callbackLocation(response)?.searchParams.get("code")).toBeFalsy();
    const body = await response.text();
    expect(body).not.toContain(config.betterAuthSecret);
    expect(body).not.toMatch(/sig=/i);
  });

  it("returns the OAuth denial redirect when consent is denied", async () => {
    const { gateway, config } = await boot();
    const flow = await prepareConsentFlow(gateway.app, config);
    const response = await postConsent(gateway.app, config, {
      path: flow.consentPath,
      cookies: flow.cookies,
      accept: false,
    });
    const callback = callbackLocation(response);
    expect(callback).not.toBeNull();
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
      headers: {
        cookie: flow.cookies,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accept: true,
        oauth_query: flow.consentQuery,
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("MISSING_OR_NULL_ORIGIN");
    expect(body.message).toMatch(/origin/i);
  });
});
