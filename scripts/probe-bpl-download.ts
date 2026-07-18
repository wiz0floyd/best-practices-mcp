/**
 * Stage spike — NOT part of the MCP server, throwaway investigation only.
 *
 * Three independent lookups all came up empty for what actually serves the file behind a Best
 * Practices Library asset (`u_x_snc_accel_asset_file_gsdr`, the primary content type this project
 * targets): the GSDR mirror record's own fields, the public BPL asset API's attachment_link, and
 * a standard sys_attachment lookup for the record. This script reuses the already-captured
 * headed-login session (no new login needed) to open a REAL, VISIBLE browser on the asset page
 * and lets a human click whatever "Download" affordance actually exists, while capturing network
 * traffic and download events to see what request really serves the file.
 *
 * Usage: npm run probe-bpl-download
 *   A visible Chromium window opens on the asset page, already logged in. Click Download (or
 *   whatever the real affordance is) — the script watches for up to 5 minutes and reports what it
 *   captured.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";

const ASSET_URL =
  "https://mynow.servicenow.com/now/best-practices/assets/stream-connect-for-apache-kafka-implementation-guide";
const WATCH_TIMEOUT_MS = 5 * 60_000;

async function main() {
  const config = loadConfig();
  const networkLog: Array<{
    url: string;
    method: string;
    resourceType: string;
    status?: number;
    contentType?: string;
    contentDisposition?: string;
  }> = [];
  const downloadEvents: Array<{ url: string; suggestedFilename: string }> = [];

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ storageState: config.authStatePath });
    const page = await context.newPage();

    page.on("response", (response) => {
      const req = response.request();
      const headers = response.headers();
      networkLog.push({
        url: response.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: response.status(),
        contentType: headers["content-type"],
        contentDisposition: headers["content-disposition"],
      });
    });

    page.on("download", (download) => {
      downloadEvents.push({ url: download.url(), suggestedFilename: download.suggestedFilename() });
      console.log(`\n>>> Download event captured: ${download.url()} (${download.suggestedFilename()})`);
    });

    console.log(`Opening ${ASSET_URL} (reusing captured session, already logged in) ...`);
    await page.goto(ASSET_URL, { waitUntil: "load", timeout: 30_000 });
    console.log(`Landed on: ${page.url()}`);

    console.log(
      `\n>>> Please click whatever "Download" affordance exists on this page now. <<<\n` +
        `Watching network traffic and download events for up to ${WATCH_TIMEOUT_MS / 60_000} minutes.\n` +
        `Once it's fired (or if there's nothing to click), press Enter in this terminal to finish\n` +
        `and write findings — do NOT use Ctrl+C, it kills the process before findings are saved.\n`
    );
    await Promise.race([
      page.waitForEvent("download", { timeout: WATCH_TIMEOUT_MS }).catch(() => {
        console.log("(no download event captured within the timeout)");
      }),
      new Promise<void>((resolve) => {
        process.stdin.resume();
        process.stdin.once("data", () => resolve());
      }),
    ]);

    mkdirSync(".probe-output", { recursive: true });
    const interesting = networkLog.filter(
      (entry) =>
        entry.contentDisposition ||
        (entry.contentType && !/^text\/html|^text\/css|javascript|^image\//.test(entry.contentType)) ||
        /\.(pptx?|docx?|xlsx?|pdf|zip)(\?|$)/i.test(entry.url)
    );
    writeFileSync(
      ".probe-output/bpl-download-findings.json",
      JSON.stringify({ assetUrl: ASSET_URL, downloadEvents, interestingNetworkLog: interesting, fullNetworkLogCount: networkLog.length }, null, 2),
      "utf-8"
    );
    console.log(`\nDownload events: ${downloadEvents.length}`);
    console.log(`Interesting network entries: ${interesting.length}`);
    console.log("Full findings written to .probe-output/bpl-download-findings.json");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
