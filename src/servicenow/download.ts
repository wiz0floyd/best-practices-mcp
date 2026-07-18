/**
 * Downloads a document behind mynow.servicenow.com's real SSO gate, using a session captured by
 * `npm run login` (src/servicenow/login.ts). Two distinct mechanisms, confirmed live:
 *
 * - Most GSDR content types (e.g. marketing decks, `u_dotcom_gsdr`): no browser needed at
 *   download time. The classic record view's XML export (`<table>.do?...&XML`) accepts cookie
 *   replay outside the browser, and the record's own fields carry the real file location
 *   directly (often a separately-hosted public CDN link). See scripts/probe-headed-login.ts.
 *
 * - Best Practices Library assets (`u_x_snc_accel_asset_file_gsdr` — this project's primary
 *   target content type): the record's own `x_snc_nl_data_extr_file_content` field carries the
 *   full extracted text of the underlying file (confirmed on both a .docx and a .pptx source —
 *   slide-by-slide for the latter) via the same plain cookie-replay XML fetch, no browser needed.
 *   This is the preferred path — it's what an agent actually wants (readable content), not bytes.
 *   Only when that field is empty does this fall back to the original file's binary bytes, which
 *   are served by a completely separate API (`api.servicenow.com/bpl/v1/attachment/<id>`) gated
 *   behind a real Okta-issued OAuth Bearer token minted client-side at click time — plain cookie
 *   replay against that API 401s, and nothing usable is cached from login either. The token IS
 *   replayable outside the browser once minted (confirmed: a captured token successfully
 *   re-fetched the same file via a separate plain curl call) — so a short-lived headless browser
 *   reusing the captured session is used only to mint one token, not to fetch the file itself.
 *   See scripts/probe-bpl-token-capture.ts for how this was confirmed. A human who wants the
 *   original formatted file directly can also just open the returned `sourceUrl` in their own
 *   browser and complete their own login — no need to go through this tool at all for that case.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { chromium } from "playwright";
import { FETCH_TIMEOUT_MS, type Config } from "../config.js";

const BPL_ASSET_TABLE = "u_x_snc_accel_asset_file_gsdr";
const BPL_ATTACHMENT_API = "https://api.servicenow.com/bpl/v1/attachment";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
}

interface StorageState {
  cookies: StorageStateCookie[];
}

export interface DownloadedDocument {
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // Present for Best Practices Library assets: the human-facing asset page. A human who wants the
  // original formatted file can open this directly and complete their own browser login — this
  // tool never needs to be involved for that case.
  sourceUrl?: string;
}

function buildCookieHeader(authStatePath: string, instanceHostname: string): string {
  const state: StorageState = JSON.parse(readFileSync(authStatePath, "utf-8"));
  return state.cookies
    .filter((c) => c.domain === instanceHostname || c.domain === `.${instanceHostname}`)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function extractField(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? match[1].trim() || null : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// The record's own fields carry the real file location (confirmed live on u_dotcom_gsdr: field
// `u_url`) — scan generically for a <u_*> tag whose name matches /url/i rather than hardcoding
// `u_url`, since other GSDR content-type tables may name it differently.
function extractUrlField(xml: string): string | null {
  const tagPattern = /<(u_[a-zA-Z0-9_]*)>([^<]*)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xml)) !== null) {
    const [, tagName, value] = match;
    const trimmed = value.trim();
    // A tag name merely containing "url" isn't proof its value is one — confirmed live: fields
    // like a boolean flag can match /url/i by name while holding "true"/"false". Require the
    // value itself to actually look like a URL before accepting it.
    if (/url/i.test(tagName) && /^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function filenameFromUrl(url: string, contentDisposition: string | null): string {
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (match) return match[1];
  }
  return decodeURIComponent(basename(new URL(url).pathname)) || "download";
}

function saveBytes(config: Config, bytes: Buffer, filename: string): string {
  mkdirSync(config.downloadDir, { recursive: true });
  const path = join(config.downloadDir, filename);
  writeFileSync(path, bytes);
  return path;
}

async function fetchRecordXml(config: Config, resultUrl: string, cookieHeader: string): Promise<string> {
  const xmlUrl = `${resultUrl}${resultUrl.includes("?") ? "&" : "?"}XML`;
  const response = await fetch(xmlUrl, {
    headers: { Cookie: cookieHeader },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`AUTH_EXPIRED:${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`ServiceNow record fetch failed with HTTP ${response.status}`);
  }
  if (response.headers.get("x-is-logged-in") !== "true") {
    throw new Error("AUTH_EXPIRED:not-logged-in");
  }

  return response.text();
}

// Mints a fresh Okta-issued Bearer token by driving a short-lived headless browser through the
// real download click — the token is generated client-side at click time (nothing usable is
// cached from login), but is replayable via plain fetch once captured, so a browser is only
// needed for this one step, not for fetching the file itself.
async function mintBplAttachmentToken(config: Config, hri: string): Promise<string> {
  const assetUrl = new URL(`/now/best-practices/assets/${hri}`, config.instanceUrl).toString();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: config.authStatePath });
    const page = await context.newPage();

    let token: string | null = null;
    page.on("request", (request) => {
      const auth = request.headers()["authorization"];
      if (auth && request.url().includes(BPL_ATTACHMENT_API)) {
        token = auth.replace(/^Bearer\s+/i, "");
      }
    });

    await page.goto(assetUrl, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(3000);

    const downloadLocator = page.getByRole("link", { name: /download/i }).or(page.getByRole("button", { name: /download/i }));
    if ((await downloadLocator.count().catch(() => 0)) === 0) {
      throw new Error(`No download affordance found on the asset page for ${hri}.`);
    }
    await downloadLocator.first().click({ timeout: 5000 });
    await page.waitForTimeout(4000);

    if (!token) {
      throw new Error(`Clicked download for ${hri} but no Bearer token was observed — the flow may have changed.`);
    }
    return token;
  } finally {
    await browser.close();
  }
}

async function downloadBplAsset(config: Config, xml: string, cookieHeader: string): Promise<DownloadedDocument> {
  const hri = extractField(xml, "u_human_readable_identifier");
  if (!hri) {
    throw new Error("Best Practices Library record is missing u_human_readable_identifier.");
  }
  const assetPageUrl = new URL(`/now/best-practices/assets/${hri}`, config.instanceUrl).toString();

  // Preferred path: the record's own extracted-text field, no browser needed. Confirmed live on
  // both a .docx and a .pptx source — this is what an agent actually wants (readable content),
  // and it's dramatically simpler/more reliable than the OAuth/browser binary path below.
  const extractedText = extractField(xml, "x_snc_nl_data_extr_file_content");
  if (extractedText) {
    const fileName = extractField(xml, "u_file_name") ?? hri;
    const text = decodeXmlEntities(extractedText);
    const bytes = Buffer.from(text, "utf-8");
    const path = saveBytes(config, bytes, `${fileName}.txt`);
    return { path, filename: `${fileName}.txt`, contentType: "text/plain", sizeBytes: bytes.length, sourceUrl: assetPageUrl };
  }

  const assetApiUrl = new URL(`/api/x_snc_bpl_user_exp/best_practices/cached/assets/${hri}`, config.instanceUrl).toString();
  const assetResponse = await fetch(assetApiUrl, {
    headers: { Cookie: cookieHeader },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (assetResponse.status === 401 || assetResponse.status === 403) {
    throw new Error(`AUTH_EXPIRED:${assetResponse.status}`);
  }
  if (!assetResponse.ok) {
    throw new Error(`Best Practices Library asset API failed with HTTP ${assetResponse.status}: ${hri}`);
  }
  const assetJson = await assetResponse.json();
  const attachSysId = assetJson?.result?.result?.asset?.previewDetails?.attachSysId;
  if (!attachSysId || typeof attachSysId !== "string") {
    throw new Error(`No previewDetails.attachSysId found for Best Practices Library asset ${hri}.`);
  }

  const token = await mintBplAttachmentToken(config, hri);

  const fileResponse = await fetch(`${BPL_ATTACHMENT_API}/${attachSysId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (fileResponse.status === 401 || fileResponse.status === 403) {
    throw new Error(`AUTH_EXPIRED:${fileResponse.status}`);
  }
  if (!fileResponse.ok) {
    throw new Error(`Failed to fetch Best Practices Library attachment (HTTP ${fileResponse.status}): ${attachSysId}`);
  }

  const contentType = fileResponse.headers.get("content-type") ?? "application/octet-stream";
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  const filename = filenameFromUrl(fileResponse.url, fileResponse.headers.get("content-disposition"));
  const path = saveBytes(config, bytes, filename);

  return { path, filename, contentType, sizeBytes: bytes.length, sourceUrl: assetPageUrl };
}

async function downloadGenericGsdrFile(config: Config, resultUrl: string, xml: string): Promise<DownloadedDocument> {
  const fileUrl = extractUrlField(xml);
  if (!fileUrl) {
    throw new Error(
      `No file URL field found on the record at ${resultUrl} — it may not be a file-backed content type.`
    );
  }

  const fileResponse = await fetch(fileUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!fileResponse.ok) {
    throw new Error(`Failed to fetch the linked file (HTTP ${fileResponse.status}): ${fileUrl}`);
  }

  const contentType = fileResponse.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = fileResponse.url;
  // A stale/moved link redirects to a generic fallback page rather than the real file — catch it
  // rather than silently saving the wrong content (confirmed live: this happens for real links).
  if (contentType.includes("text/html") || new URL(finalUrl).hostname !== new URL(fileUrl).hostname) {
    throw new Error(
      `The linked file appears to have moved or been removed (redirected to ${finalUrl} instead of serving the file): ${fileUrl}`
    );
  }

  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  const filename = filenameFromUrl(fileUrl, fileResponse.headers.get("content-disposition"));
  const path = saveBytes(config, bytes, filename);

  return { path, filename, contentType, sizeBytes: bytes.length };
}

export async function downloadServiceNowDocument(config: Config, resultUrl: string): Promise<DownloadedDocument> {
  if (!existsSync(config.authStatePath)) {
    throw new Error("AUTH_EXPIRED:no-session-file");
  }

  const instanceHostname = new URL(config.instanceUrl).hostname;
  const cookieHeader = buildCookieHeader(config.authStatePath, instanceHostname);
  const xml = await fetchRecordXml(config, resultUrl, cookieHeader);

  if (resultUrl.includes(`/${BPL_ASSET_TABLE}.do`)) {
    return downloadBplAsset(config, xml, cookieHeader);
  }
  return downloadGenericGsdrFile(config, resultUrl, xml);
}
