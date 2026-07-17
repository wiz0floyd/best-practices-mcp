/**
 * mynow.servicenow.com's search API is genuinely unauthenticated, but it still runs on the
 * standard ServiceNow session model: an anonymous "guest" session cookie (issued on any page
 * load) paired with a CSRF token (`window.g_ck`, embedded in that same page's HTML), sent back
 * as the `X-UserToken` header on API calls. No login, no credentials — just a session
 * bootstrap. Confirmed via a cold, browser-free curl round-trip (GET page -> extract cookie +
 * g_ck -> POST /api/now/v1/batch with both) returning real, correctly-scored results.
 */

import { FETCH_TIMEOUT_MS } from "../config.js";

export interface GuestSession {
  cookie: string;
  userToken: string;
}

const GCK_PATTERN = /window\.g_ck\s*=\s*'([^']+)'/;

export async function acquireGuestSession(instanceUrl: string): Promise<GuestSession> {
  const response = await fetch(new URL("/now/best-practices/home", instanceUrl), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to establish a guest session against ${instanceUrl} (HTTP ${response.status}).`
    );
  }

  const cookie = response.headers
    .getSetCookie()
    .map((h) => h.split(";")[0])
    .join("; ");

  const html = await response.text();
  const match = html.match(GCK_PATTERN);
  if (!match) {
    throw new Error(
      "Could not find window.g_ck in the page response — the site's session bootstrap may have changed. " +
        "Re-run scripts/probe.ts to confirm."
    );
  }

  return { cookie, userToken: match[1] };
}
