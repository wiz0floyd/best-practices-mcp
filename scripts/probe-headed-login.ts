/**
 * Stage 1 spike (see docs/plans or task history for "headed SSO session capture for document
 * download") — NOT part of the MCP server, throwaway investigation only.
 *
 * scripts/probe-content-page.ts already proved (headless, no real credentials) that file-backed
 * result pages redirect through a real Okta SSO flow (signon.servicenow.com /
 * ssosignon.servicenow.com) and land on a "Sign in with your ServiceNow ID" page. Nobody has
 * completed that login yet, so the actual post-auth download mechanism — a direct authenticated
 * file stream, a SPA render with a Download button, or a JS-driven blob download — is still
 * unknown. This script opens a REAL, VISIBLE (headless: false) browser so a human can complete
 * the login by hand, then reuses the same network-log / download-event instrumentation from
 * probe-content-page.ts's checkFileBackedMechanism(), now authenticated, to finally observe it.
 *
 * It also persists the resulting session via context.storageState() so the captured cookies can
 * be inspected manually — this is a spike of the same mechanism src/servicenow/login.ts will hew
 * to once the download mechanism below is confirmed.
 *
 * Usage: npm run probe-headed-login
 *   A visible Chromium window opens. Complete the real ServiceNow ID / Okta login by hand. The
 *   script detects the navigation back to mynow.servicenow.com and takes it from there.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

// Same file-backed result URL used in probe-content-page.ts's checkFileBackedMechanism().
const FILE_BACKED_URL =
  "https://mynow.servicenow.com/u_dotcom_gsdr.do?sys_id=5bca2ad02b432210c433fe58ce91bfef&sysparm_view=text_search&searchTerm=deck";

// A real SAML SSO round-trip bounces through domains that can't be fully enumerated up front —
// signon.servicenow.com, ssosignon.servicenow.com, and (confirmed live) the IdP's own domain
// (servicenow.okta.com/app/.../sso/saml) as an intermediate hop before finally landing back on
// the instance. Blocklisting known SSO domains is a trap (missing just one, like Okta's own
// domain, makes the wait resolve early mid-flow with a login-page/IdP session captured instead of
// the real one). Allowlist the one thing that's actually known: the instance hostname itself.
const INSTANCE_HOSTNAME = new URL(FILE_BACKED_URL).hostname;

function isBackOnInstance(url: URL): boolean {
  return url.hostname === INSTANCE_HOSTNAME;
}

// Minutes-scale — a human has to actually type credentials and complete SSO/MFA by hand.
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const STORAGE_STATE_PATH = ".probe-output/servicenow-storage-state.json";

async function main() {
  const findings: Record<string, unknown> = { url: FILE_BACKED_URL };
  const networkLog: Array<{
    url: string;
    method: string;
    resourceType: string;
    status?: number;
    contentType?: string;
    contentDisposition?: string;
  }> = [];
  const downloadEvents: Array<{ url: string; suggestedFilename: string }> = [];
  // Bodies of the record-rendering API calls (databroker/exec, GraphQL, batch) — the record's own
  // fields (likely including a real file URL) live here, whether or not the rendered UI ever
  // exposes a clickable download link.
  const apiResponses: Array<{ url: string; body: unknown }> = [];

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Attach listeners before navigating so we catch everything — including anything that fires
    // automatically on the redirect back from login, not just interactions after landing.
    page.on("response", async (response) => {
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

      if (/\/api\/now\/(uxf\/databroker\/exec|graphql|v1\/batch)/.test(response.url())) {
        try {
          const body = await response.json();
          apiResponses.push({ url: response.url(), body });
        } catch {
          // Not JSON (or body already consumed) — skip.
        }
      }
    });

    page.on("download", (download) => {
      downloadEvents.push({ url: download.url(), suggestedFilename: download.suggestedFilename() });
    });

    console.log(`Opening ${FILE_BACKED_URL} ...`);
    await page.goto(FILE_BACKED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log(`Landed on: ${page.url()}`);

    if (!isBackOnInstance(new URL(page.url()))) {
      console.log(
        "\n>>> Please complete the real ServiceNow ID / Okta login in the visible browser window now. <<<\n" +
          `Waiting up to ${LOGIN_TIMEOUT_MS / 60_000} minutes for the browser to return to ${INSTANCE_HOSTNAME}...\n`
      );
      await page.waitForURL((url) => isBackOnInstance(url), { timeout: LOGIN_TIMEOUT_MS });
    } else {
      console.log("Already on the instance (no login prompt shown) — continuing.");
    }

    console.log(`Back on: ${page.url()} — waiting for the page to settle...`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {
      console.log("(networkidle wait timed out — continuing anyway)");
    });

    // Next Experience wraps the classic .do content in an embedded "OpenFrame" iframe rather than
    // navigating the top-level document to it directly (see postLoginUrl's
    // /now/nav/ui/classic/params/target/... shape and the sn-openframe-uxb component request) —
    // that's why a raw document.body DOM scan on the top frame came back empty. Use the
    // accessibility tree instead of DOM queries for discovery: Chromium's AX tree is unified
    // across same-process (same-origin) frames, so it sees into the embedded classic content
    // without needing to guess which frame URL actually holds it.
    findings.frameUrls = page.frames().map((f) => f.url());
    console.log(`Frames on page: ${JSON.stringify(findings.frameUrls)}`);

    interface A11yNode {
      role?: string;
      name?: string;
      children?: A11yNode[];
    }

    function collectText(node: A11yNode | null, acc: string[] = []): string[] {
      if (!node) return acc;
      if (node.name) acc.push(node.name);
      for (const child of node.children ?? []) collectText(child, acc);
      return acc;
    }

    function collectDownloadCandidates(
      node: A11yNode | null,
      acc: Array<{ role: string; name: string }> = []
    ): Array<{ role: string; name: string }> {
      if (!node) return acc;
      const name = (node.name || "").trim();
      if (
        (node.role === "link" || node.role === "button") &&
        (/download/i.test(name) || /\.(pptx?|docx?|xlsx?|pdf|zip)\b/i.test(name))
      ) {
        acc.push({ role: node.role, name });
      }
      for (const child of node.children ?? []) collectDownloadCandidates(child, acc);
      return acc;
    }

    const snapshot = (await page.accessibility.snapshot({ interestingOnly: false })) as A11yNode | null;
    findings.postLoginUrl = page.url();
    findings.bodyInnerTextPreview = collectText(snapshot).join(" ").slice(0, 2000);

    const downloadLinks = collectDownloadCandidates(snapshot);
    findings.candidateDownloadLinks = downloadLinks;
    console.log("Candidate download links found via accessibility tree:", JSON.stringify(downloadLinks, null, 2));

    // The record itself may just carry the real file location as a field (e.g. a "URL"/"u_url"
    // column synced from wherever the content actually lives) — scan the captured
    // databroker/graphql/batch response bodies for anything URL-shaped rather than relying on the
    // rendered UI exposing a clickable link at all.
    function findUrlFields(
      obj: unknown,
      path = "",
      acc: Array<{ path: string; value: string }> = []
    ): Array<{ path: string; value: string }> {
      if (obj === null || typeof obj !== "object") return acc;
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (typeof value === "string" && /url/i.test(key) && value.length > 0) {
          acc.push({ path: nextPath, value });
        }
        findUrlFields(value, nextPath, acc);
      }
      return acc;
    }

    const urlFieldCandidates = apiResponses.flatMap((r) =>
      findUrlFields(r.body).map((f) => ({ apiUrl: r.url, ...f }))
    );
    findings.urlFieldCandidates = urlFieldCandidates;
    console.log("URL-like fields found in record API responses:", JSON.stringify(urlFieldCandidates, null, 2));

    if (downloadEvents.length === 0 && downloadLinks.length > 0) {
      const candidateName = downloadLinks[0].name;
      const candidateRole = downloadLinks[0].role as "link" | "button";
      // The a11y tree told us the candidate exists somewhere, but clicking still needs a concrete
      // frame — Playwright locators don't auto-pierce iframes for actions. Try each frame in turn.
      const downloadPromise = page.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
      const candidateFrames = [page.mainFrame(), ...page.frames()];
      let clicked = false;
      for (const frame of candidateFrames) {
        try {
          await frame.getByRole(candidateRole, { name: candidateName, exact: false }).first().click({ timeout: 3000 });
          clicked = true;
          break;
        } catch {
          // Not present/clickable in this frame — try the next one.
        }
      }
      console.log(
        clicked
          ? "Clicked a candidate link/button; waiting for a download event..."
          : "Found a candidate via the accessibility tree but couldn't click it in any frame."
      );
      const download = await downloadPromise;
      if (download) {
        console.log(`Download event fired: ${download.url()} (${download.suggestedFilename()})`);
      } else if (clicked) {
        console.log("Click succeeded but no download event captured within timeout.");
      }
    }

    findings.networkLog = networkLog.filter(
      (entry) =>
        entry.contentDisposition ||
        (entry.contentType && !/^text\/html|^text\/css|javascript|^image\//.test(entry.contentType)) ||
        /\.(pptx?|docx?|xlsx?|pdf|zip)(\?|$)/i.test(entry.url)
    );
    findings.downloadEvents = downloadEvents;
    findings.verdict =
      downloadEvents.length > 0
        ? "Browser-driven download event fired (SPA button or blob) — see downloadEvents."
        : (findings.networkLog as unknown[]).some(
            (e) => (e as { contentDisposition?: string }).contentDisposition
          )
        ? "A response with Content-Disposition was observed — likely a direct authenticated file stream, no browser needed at request time."
        : "No download event and no Content-Disposition observed — inspect bodyInnerTextPreview and networkLog manually.";
    console.log(`\nVerdict: ${findings.verdict}`);

    mkdirSync(".probe-output", { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Storage state captured to ${STORAGE_STATE_PATH}`);
  } finally {
    await browser.close();
  }

  writeFileSync(".probe-output/headed-login-findings.json", JSON.stringify(findings, null, 2), "utf-8");
  console.log("\nFull findings written to .probe-output/headed-login-findings.json");
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
