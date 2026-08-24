import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSENT_CSRF_TTL_SECONDS = 15 * 60;

/**
 * Domain and version marker for the hosted consent CSRF token. Bump the
 * version whenever the signed payload changes so old tokens stop verifying.
 */
const CONSENT_CSRF_DOMAIN = "agentmemory-mcp-gateway/consent-csrf/v1";

export type ConsentCsrfResult = "valid" | "malformed" | "expired" | "invalid";

function sign(secret: string, sessionId: string, exp: number, oauthQuery: string): string {
  return createHmac("sha256", secret)
    .update(`${CONSENT_CSRF_DOMAIN}\n${sessionId}\n${exp}\n${oauthQuery}`)
    .digest("hex");
}

function equalSignatures(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Short-lived token bound to the current session, the exact raw signed OAuth
 * query, and an expiry. It is the only accepted proof that a hosted consent
 * POST came from the consent page this session was served.
 */
export function createConsentCsrfToken(input: {
  secret: string;
  sessionId: string;
  oauthQuery: string;
  nowMs?: number;
}): string {
  const exp = Math.floor((input.nowMs ?? Date.now()) / 1000) + CONSENT_CSRF_TTL_SECONDS;
  return `${exp}.${sign(input.secret, input.sessionId, exp, input.oauthQuery)}`;
}

export function verifyConsentCsrfToken(input: {
  secret: string;
  sessionId: string;
  oauthQuery: string;
  token: string;
  nowMs?: number;
}): ConsentCsrfResult {
  const separator = input.token.indexOf(".");
  if (separator <= 0 || separator === input.token.length - 1) {
    return "malformed";
  }
  const exp = Number(input.token.slice(0, separator));
  const signature = input.token.slice(separator + 1);
  if (!Number.isInteger(exp) || signature.length === 0) {
    return "malformed";
  }
  if (exp * 1000 < (input.nowMs ?? Date.now())) {
    return "expired";
  }
  const expected = sign(input.secret, input.sessionId, exp, input.oauthQuery);
  return equalSignatures(signature, expected) ? "valid" : "invalid";
}

/**
 * Headers for the internal forward to Better Auth's `/oauth2/consent`.
 *
 * Browser headers are not CSRF evidence here, so none of them are relayed.
 * Only the session cookie is carried over, and Origin is pinned to the exact
 * configured public origin so Better Auth's own origin check stays enabled.
 */
export function internalConsentHeaders(cookie: string | null, publicOrigin: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    origin: publicOrigin,
  });
  if (cookie) {
    headers.set("cookie", cookie);
  }
  return headers;
}
