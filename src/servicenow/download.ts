/**
 * Downloads a document behind mynow.servicenow.com's real SSO gate, using a session captured by
 * `npm run login` (src/servicenow/login.ts). No browser is launched here — confirmed live that
 * the classic record view's XML export (`<table>.do?...&XML`) accepts cookie replay outside the
 * browser, and the record's own fields carry the real (often separately-hosted, public CDN) file
 * location directly. See scripts/probe-headed-login.ts for how this was confirmed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { FETCH_TIMEOUT_MS, type Config } from "../config.js";

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
}

function buildCookieHeader(authStatePath: string, instanceHostname: string): string {
  const state: StorageState = JSON.parse(readFileSync(authStatePath, "utf-8"));
  return state.cookies
    .filter((c) => c.domain === instanceHostname || c.domain === `.${instanceHostname}`)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
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

export async function downloadServiceNowDocument(config: Config, resultUrl: string): Promise<DownloadedDocument> {
  if (!existsSync(config.authStatePath)) {
    throw new Error("AUTH_EXPIRED:no-session-file");
  }

  const instanceHostname = new URL(config.instanceUrl).hostname;
  const cookieHeader = buildCookieHeader(config.authStatePath, instanceHostname);

  const xmlUrl = `${resultUrl}${resultUrl.includes("?") ? "&" : "?"}XML`;
  const recordResponse = await fetch(xmlUrl, {
    headers: { Cookie: cookieHeader },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (recordResponse.status === 401 || recordResponse.status === 403) {
    throw new Error(`AUTH_EXPIRED:${recordResponse.status}`);
  }
  if (!recordResponse.ok) {
    throw new Error(`ServiceNow record fetch failed with HTTP ${recordResponse.status}`);
  }
  if (recordResponse.headers.get("x-is-logged-in") !== "true") {
    throw new Error("AUTH_EXPIRED:not-logged-in");
  }

  const xml = await recordResponse.text();
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

  mkdirSync(config.downloadDir, { recursive: true });
  const path = join(config.downloadDir, filename);
  writeFileSync(path, bytes);

  return { path, filename, contentType, sizeBytes: bytes.length };
}
