/**
 * Headed (visible-browser) SSO session capture. A human completes the real ServiceNow ID / Okta
 * login by hand; the captured cookies are then reused by src/servicenow/download.ts via plain
 * cookie replay — no resident browser process needed at download time (confirmed live: the
 * classic .do?...&XML record view accepts cookie replay outside the browser). See
 * scripts/probe-headed-login.ts for the original spike this was hardened from.
 *
 * Never call this from inside an MCP tool — a headed browser waiting minutes on human SSO/MFA
 * input has no business running inside a tool-call timeout. It's invoked only from the standalone
 * scripts/login.ts CLI (`npm run login`).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { LOGIN_TIMEOUT_MS, type Config } from "../config.js";

// The instance's own home/search pages are intentionally unauthenticated, so they won't trigger
// an SSO prompt — use a real file-backed record URL, confirmed live to redirect through Okta SSO.
const DEFAULT_LOGIN_TARGET_PATH =
  "/u_dotcom_gsdr.do?sys_id=5bca2ad02b432210c433fe58ce91bfef&sysparm_view=text_search&searchTerm=deck";

// A real SAML round-trip bounces through IdP-owned domains (confirmed live: Okta's own
// servicenow.okta.com SAML endpoint) that can't be fully enumerated up front — allowlisting the
// one thing that's actually known (the instance's own hostname) is more robust than blocklisting
// every possible SSO-hop domain, which resolves early the moment one is missed.
export function isBackOnInstance(url: URL, instanceHostname: string): boolean {
  return url.hostname === instanceHostname;
}

export async function captureServiceNowSession(config: Config, targetUrl?: string): Promise<void> {
  const target = targetUrl ?? new URL(DEFAULT_LOGIN_TARGET_PATH, config.instanceUrl).toString();
  const instanceHostname = new URL(config.instanceUrl).hostname;

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`Opening ${target} ...`);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });

    if (!isBackOnInstance(new URL(page.url()), instanceHostname)) {
      console.log(
        "\n>>> Please complete the real ServiceNow ID / Okta login in the visible browser window now. <<<\n" +
          `Waiting up to ${LOGIN_TIMEOUT_MS / 60_000} minutes for the browser to return to ${instanceHostname}...\n`
      );
      await page.waitForURL((url) => isBackOnInstance(url, instanceHostname), { timeout: LOGIN_TIMEOUT_MS });
    } else {
      console.log("Already on the instance (no login prompt shown) — continuing.");
    }

    mkdirSync(dirname(config.authStatePath), { recursive: true });
    await context.storageState({ path: config.authStatePath });
    console.log(`Session captured to ${config.authStatePath}`);
  } finally {
    await browser.close();
  }
}
