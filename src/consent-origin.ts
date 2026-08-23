const SAME_ORIGIN_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

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

function hasSessionCookie(headers: Headers): boolean {
  const cookie = headerValue(headers, "cookie");
  return cookie !== null;
}

/**
 * Same-origin check for the hosted consent form.
 *
 * A matching Origin is accepted. Browsers and webviews that omit Origin can
 * still pass with Fetch Metadata, a same-origin Referer, or a SameSite session
 * cookie on a request that is not marked cross-site.
 */
export function isTrustedConsentSubmission(headers: Headers, publicOrigin: string): boolean {
  const origin = headerValue(headers, "origin");
  const referer = headerValue(headers, "referer");
  const fetchSite = headerValue(headers, "sec-fetch-site")?.toLowerCase();

  if (fetchSite === "cross-site") {
    return false;
  }

  if (origin !== null) {
    return matchesPublicOrigin(origin, publicOrigin);
  }

  if (referer !== null) {
    return matchesPublicOrigin(referer, publicOrigin);
  }

  if (fetchSite && SAME_ORIGIN_FETCH_SITES.has(fetchSite)) {
    return true;
  }

  return hasSessionCookie(headers);
}

export function trustedInternalConsentHeaders(incoming: Headers, publicOrigin: string): Headers {
  const headers = new Headers(incoming);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.set("origin", publicOrigin);
  return headers;
}
