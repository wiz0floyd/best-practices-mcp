/**
 * Stage spike — NOT part of the MCP server, throwaway investigation only.
 *
 * api.servicenow.com/bpl/v1/attachment/<id> requires a real Okta-issued Bearer token
 * (WWW-Authenticate: Bearer realm="servicenow.okta.com") — confirmed that mynow.servicenow.com's
 * own /api/x_snc_onecx/auth/getAuthToken result is NOT that token (still 401s). Nothing useful
 * was cached in localStorage from login either — the real token is minted fresh at click time.
 * This script reuses the already-captured session (headless, no human needed — already
 * authenticated), automates the download click, and inspects the REQUEST headers of whatever
 * calls precede/constitute the attachment fetch to find where the real token actually comes from.
 *
 * Usage: npm run probe-bpl-token-capture
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";

const ASSET_URL =
  "https://mynow.servicenow.com/now/best-practices/assets/stream-connect-for-apache-kafka-implementation-guide";

async function main() {
  const config = loadConfig();
  const tokenBearingRequests: Array<{ url: string; authPresent: boolean; authLength: number }> = [];
  const authRedactedLog: string[] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: config.authStatePath });
    const page = await context.newPage();

    page.on("request", (request) => {
      const auth = request.headers()["authorization"];
      if (auth || /api\.servicenow\.com|okta|token/i.test(request.url())) {
        tokenBearingRequests.push({
          url: request.url(),
          authPresent: Boolean(auth),
          authLength: auth ? auth.length : 0,
        });
        authRedactedLog.push(`${request.method()} ${request.url()} | auth=${auth ? `present(len=${auth.length})` : "none"}`);
        if (auth && request.url().includes("api.servicenow.com/bpl/v1/attachment")) {
          mkdirSync(".probe-output", { recursive: true });
          writeFileSync(".probe-output/.captured-bearer.tmp", auth.replace(/^Bearer\s+/i, ""), "utf-8");
        }
      }
    });

    console.log(`Opening ${ASSET_URL} (headless, reusing captured session) ...`);
    await page.goto(ASSET_URL, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(3000);

    const downloadLocator = page.getByRole("link", { name: /download/i }).or(page.getByRole("button", { name: /download/i }));
    const candidateCount = await downloadLocator.count().catch(() => 0);
    console.log(`Download candidates found via getByRole: ${candidateCount}`);

    if (candidateCount > 0) {
      await downloadLocator
        .first()
        .click({ timeout: 5000 })
        .catch((e) => console.log("click failed:", e instanceof Error ? e.message : String(e)));
      await page.waitForTimeout(4000);
    } else {
      console.log("No download candidate found via getByRole.");
    }

    mkdirSync(".probe-output", { recursive: true });
    writeFileSync(".probe-output/bpl-token-capture-requests.txt", authRedactedLog.join("\n"), "utf-8");
    console.log(`\n${tokenBearingRequests.length} relevant requests logged to .probe-output/bpl-token-capture-requests.txt`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
