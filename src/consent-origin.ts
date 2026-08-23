import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSENT_CSRF_TTL_SECONDS = 15 * 60;

export type ConsentTrust = "allow" | "deny" | "csrf";

function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function httpOrigin(value: string): string | null {
  if (value === "null") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function matchesPublicOrigin(value: string, publicOrigin: string): boolean {
  return httpOrigin(value) === publicOrigin;
}

function signConsentCsrf(
  secret: string,
  sessionId: string,
  exp: number,
  oauthQuery: string,
): string {
  return createHmac("sha256", secret)
    .update(`v1\n${sessionId}\n${exp}\n${oauthQuery}`)
    .digest("hex");
}

function equalHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Same-origin evidence for the hosted consent form.
 *
 * Allow only an exact configured Origin, an exact same-origin Referer, or
 * Sec-Fetch-Site: same-origin. Sibling same-site and cookie-only requests
 * are not treated as same-origin. Those must present a session-bound CSRF
 * token, and only when the browser did not attest a different site.
 */
export function evaluateConsentTrust(headers: Headers, publicOrigin: string): ConsentTrust {
  const origin = headerValue(headers, "origin");
  const referer = headerValue(headers, "referer");
  const fetchSite = headerValue(headers, "sec-fetch-site")?.toLowerCase();

  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return "deny";
  }

  if (origin !== null) {
    return matchesPublicOrigin(origin, publicOrigin) ? "allow" : "deny";
  }

  if (referer !== null) {
    return matchesPublicOrigin(referer, publicOrigin) ? "allow" : "deny";
  }

  if (fetchSite === "same-origin") {
    return "allow";
  }

  return "csrf";
}

export function isTrustedConsentSubmission(headers: Headers, publicOrigin: string): boolean {
  return evaluateConsentTrust(headers, publicOrigin) === "allow";
}

export function createConsentCsrfToken(input: {
  secret: string;
  sessionId: string;
  oauthQuery: string;
  nowMs?: number;
}): string {
  const exp = Math.floor((input.nowMs ?? Date.now()) / 1000) + CONSENT_CSRF_TTL_SECONDS;
  return `${exp}.${signConsentCsrf(input.secret, input.sessionId, exp, input.oauthQuery)}`;
}

export function verifyConsentCsrfToken(input: {
  secret: string;
  sessionId: string;
  oauthQuery: string;
  token: string;
  nowMs?: number;
}): boolean {
  const separator = input.token.indexOf(".");
  if (separator <= 0 || separator === input.token.length - 1) {
    return false;
  }
  const exp = Number(input.token.slice(0, separator));
  const signature = input.token.slice(separator + 1);
  if (!Number.isInteger(exp) || signature.length === 0) {
    return false;
  }
  if (exp * 1000 < (input.nowMs ?? Date.now())) {
    return false;
  }
  const expected = signConsentCsrf(input.secret, input.sessionId, exp, input.oauthQuery);
  return equalHex(signature, expected);
}

export function trustedInternalConsentHeaders(incoming: Headers, publicOrigin: string): Headers {
  const headers = new Headers(incoming);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.set("origin", publicOrigin);
  return headers;
}
