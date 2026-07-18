/**
 * Stage 1b spike (see feature plan for "load content after searching") — NOT part of the MCP
 * server, throwaway investigation only. mynow.servicenow.com is NOT a standard ServiceNow
 * instance and must be treated as an unknown web page — nothing here assumes standard ServiceNow
 * platform conventions (sys_attachment.do, Attachment REST API, Document Viewer). Everything is
 * discovered empirically via Playwright, same discipline as scripts/probe.ts used for search.
 *
 * Answers two questions:
 *   1. Is an ARTICLE-type .do page (e.g. a Now Support Knowledge record) server-rendered (the
 *      full text is present in a plain unauthenticated fetch()) or a SPA/shadow-DOM shell that
 *      only resolves after JS execution?
 *   2. For a FILE-BACKED stub result (e.g. a "Deck"/"ServiceNow.com" record), what mechanism
 *      actually serves the underlying file — a plain navigable download URL, a JS-triggered
 *      blob download, or something else? Captured via network log + page.on('download').
 *
 * Usage: npm run probe-content-page
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const ARTICLE_URL =
  "https://mynow.servicenow.com/u_hi_kb_knowledge_gsdr.do?sys_id=44c90bfa3bc6c710f86df09704e45ad6&sysparm_view=text_search&searchTerm=stream%20connect";
const ARTICLE_NEEDLE = "Validate connectivity and bootstrap consuming/producing on the MID host";

const FILE_BACKED_URL =
  "https://mynow.servicenow.com/u_dotcom_gsdr.do?sys_id=5bca2ad02b432210c433fe58ce91bfef&sysparm_view=text_search&searchTerm=deck";

async function checkArticleSsrVsSpa() {
  console.log("--- Article SSR-vs-SPA check ---");
  const findings: Record<string, unknown> = { url: ARTICLE_URL };

  // Plain unauthenticated fetch (no JS execution) — does the raw HTML already contain the text?
  const rawResponse = await fetch(ARTICLE_URL);
  const rawHtml = await rawResponse.text();
  const rawContainsText = rawHtml.includes(ARTICLE_NEEDLE);
  console.log(`Plain fetch: HTTP ${rawResponse.status}, length ${rawHtml.length}, contains article text: ${rawContainsText}`);
  findings.plainFetchStatus = rawResponse.status;
  findings.plainFetchLength = rawHtml.length;
  findings.plainFetchContainsText = rawContainsText;

  // Playwright-rendered version
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(ARTICLE_URL, { waitUntil: "networkidle", timeout: 30000 });
    const renderedHtml = await page.content();
    const renderedContainsText = renderedHtml.includes(ARTICLE_NEEDLE);
    const bodyInnerText = await page.evaluate(() => document.body.innerText);
    console.log(
      `Rendered: length ${renderedHtml.length}, contains article text: ${renderedContainsText}, ` +
      `body.innerText length: ${bodyInnerText.length}, innerText contains text: ${bodyInnerText.includes(ARTICLE_NEEDLE)}`
    );
    findings.renderedHtmlLength = renderedHtml.length;
    findings.renderedContainsText = renderedContainsText;
    findings.bodyInnerTextLength = bodyInnerText.length;
    findings.bodyInnerTextContainsText = bodyInnerText.includes(ARTICLE_NEEDLE);
    findings.verdict = rawContainsText
      ? "SSR — plain fetch already contains article text"
      : renderedContainsText || bodyInnerText.includes(ARTICLE_NEEDLE)
      ? "SPA — only present after JS render"
      : "NEITHER — text not found in raw fetch OR rendered page; investigate manually";
    console.log(`Verdict: ${findings.verdict}`);
  } finally {
    await browser.close();
  }
  return findings;
}

async function checkFileBackedMechanism() {
  console.log("\n--- File-backed download mechanism discovery ---");
  const findings: Record<string, unknown> = { url: FILE_BACKED_URL };
  const networkLog: Array<{ url: string; method: string; resourceType: string; status?: number; contentType?: string; contentDisposition?: string }> = [];
  const downloadEvents: Array<{ url: string; suggestedFilename: string }> = [];

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

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
    });

    page.on("download", (download) => {
      downloadEvents.push({ url: download.url(), suggestedFilename: download.suggestedFilename() });
    });

    await page.goto(FILE_BACKED_URL, { waitUntil: "networkidle", timeout: 30000 });

    const bodyInnerText = await page.evaluate(() => document.body.innerText);
    findings.bodyInnerTextPreview = bodyInnerText.slice(0, 2000);

    // Look for anything that looks like a download affordance in the rendered DOM.
    const downloadLinks = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll("a")];
      return anchors
        .filter((a) => {
          const text = (a.textContent || "").toLowerCase();
          const href = a.getAttribute("href") || "";
          return (
            text.includes("download") ||
            /\.(pptx?|docx?|xlsx?|pdf|zip)(\?|$)/i.test(href)
          );
        })
        .map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") }));
    });
    findings.candidateDownloadLinks = downloadLinks;
    console.log("Candidate download links found in DOM:", JSON.stringify(downloadLinks, null, 2));

    // If we found a candidate link, try clicking it and see if a download event or navigation fires.
    if (downloadLinks.length > 0) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
          page.click(`a:has-text("${downloadLinks[0].text ?? "Download"}")`, { timeout: 5000 }).catch(() => null),
        ]);
        if (download) {
          console.log(`Download event fired: ${download.url()} (${download.suggestedFilename()})`);
        } else {
          console.log("Click attempted but no download event captured within timeout.");
        }
      } catch (err) {
        console.log("Click attempt failed:", err instanceof Error ? err.message : String(err));
      }
    }

    findings.networkLog = networkLog.filter(
      (entry) =>
        entry.contentDisposition ||
        (entry.contentType && !/^text\/html|^text\/css|javascript|^image\//.test(entry.contentType)) ||
        /\.(pptx?|docx?|xlsx?|pdf|zip)(\?|$)/i.test(entry.url)
    );
    findings.downloadEvents = downloadEvents;
    console.log(`Network entries of interest: ${(findings.networkLog as unknown[]).length}`);
    console.log("Download events:", downloadEvents);
  } finally {
    await browser.close();
  }
  return findings;
}

async function main() {
  const articleFindings = await checkArticleSsrVsSpa();
  const fileFindings = await checkFileBackedMechanism();

  mkdirSync(".probe-output", { recursive: true });
  writeFileSync(
    ".probe-output/content-page-findings.json",
    JSON.stringify({ articleFindings, fileFindings }, null, 2),
    "utf-8"
  );
  console.log("\nFull findings written to .probe-output/content-page-findings.json");
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
