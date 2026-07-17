import { FETCH_TIMEOUT_MS, type Config } from "../config.js";
import { acquireGuestSession, type GuestSession } from "./session.js";
import type { NormalizedSearchResponse, NormalizedSearchResult, SearchParams } from "../types.js";
import { extractContentTypeIntent } from "./intent.js";

/**
 * Reverse-engineered from a Playwright network capture of mynow.servicenow.com's own search UI
 * (see the "Don't Trust Assumed ServiceNow Search REST Endpoints" Team-Brain gotcha for the
 * general technique, and this repo's scripts/probe.ts for a standalone re-verification script).
 * Confirmed genuinely unauthenticated with a cold curl round-trip — no cookies/session reused
 * from the capture itself.
 *
 * Flow: GET any mynow page for a guest session cookie + CSRF token (window.g_ck), then POST
 * /api/now/v1/batch wrapping a GraphQL call to the Genius Search data broker definition. The
 * config IDs below (searchContextConfigId, searchEvamConfigId, definitionSysId) are fixed,
 * non-secret widget identifiers captured from the real frontend request — not user-specific.
 */

const BATCH_PATH = "/api/now/v1/batch";
const SEARCH_DEFINITION_SYS_ID = "cfc77d057300101052c7d5fdbdf6a73d";
const SEARCH_CONTEXT_CONFIG_ID = "215a0579fb092e1012b7fda8beefdc4c";
const SEARCH_EVAM_CONFIG_ID = "80eb579d53671010968addeeff7b1215";

let cachedSession: GuestSession | null = null;

/**
 * Content-type table identifiers (e.g. "u_hi_kb_knowledge_gsdr") are raw internal sysIds, not
 * guessable from standard ServiceNow table names — see the "ServiceNow Genius Search contentType
 * Facets Use Raw Internal Table Names" Team-Brain gotcha. Every real search response observes a
 * few (table, label) pairs "for free"; this registry accumulates them across calls so
 * src/servicenow/contentTypes.ts can serve discovery from cache instead of guessing or spending an
 * extra query.
 */
const contentTypeRegistry = new Map<string, string>();
let lastFacetCounts: Array<{ label: string; count: number }> = [];
let registryUpdatedAt: number | null = null;

export function getObservedContentTypes(): Array<{ table: string; label: string }> {
  return [...contentTypeRegistry.entries()].map(([table, label]) => ({ table, label }));
}

export function getLastFacetCounts(): Array<{ label: string; count: number }> {
  return lastFacetCounts;
}

export function getContentTypeRegistryUpdatedAt(): number | null {
  return registryUpdatedAt;
}

function jsonLiteral(value: unknown): { type: "JSON_LITERAL"; value: unknown } {
  return { type: "JSON_LITERAL", value };
}

function stripHighlight(text: string): string {
  return text.replace(/<\/?highlight>/g, "");
}

/**
 * The API's paginationToken is base64 of an internal offset breadcrumb like "offset:0,10", with
 * '=' padding replaced by '.'. Constructing "offset:0,<n>" jumps straight to row n — the breadcrumb
 * trail is not validated server-side (verified: "offset:0,100" returns rows 100-109 directly). This
 * gives random-access offset paging on top of a cursor API. The page size stays fixed at 10; only
 * the start offset is controllable. If ServiceNow ever changes this encoding, scripts/probe.ts will
 * surface it — re-discover the format from a fresh capture rather than guessing.
 */
function encodeOffsetToken(offset: number): string {
  return Buffer.from(`offset:0,${offset}`, "utf-8").toString("base64").replace(/=/g, ".");
}

function buildBatchBody(query: string, userToken: string, paginationToken: string | null) {
  return {
    batch_request_id: crypto.randomUUID(),
    enforce_order: false,
    rest_requests: [
      {
        id: "r1",
        method: "POST",
        options: { is_encoded: false, should_encode_response: false },
        url: "/api/now/uxf/databroker/exec",
        headers: [{ name: "X-UserToken", value: userToken }],
        body: [
          {
            type: "GRAPHQL",
            definitionSysId: SEARCH_DEFINITION_SYS_ID,
            inputValues: {
              requestedFields: jsonLiteral(JSON.stringify({ global: ["title", "text", "sys_id"] })),
              facetFilters: jsonLiteral("[]"),
              disableSpellCheck: jsonLiteral(false),
              locale: jsonLiteral(""),
              isDebug: jsonLiteral(false),
              paginationToken: jsonLiteral(paginationToken),
              setSemanticSearch: jsonLiteral(false),
              searchEvamConfigId: jsonLiteral(SEARCH_EVAM_CONFIG_ID),
              searchTerm: jsonLiteral(query),
              sortOptions: jsonLiteral(""),
              forceSkipSignalsLogging: jsonLiteral(false),
              searchFilters: jsonLiteral("[]"),
              searchPurview: jsonLiteral("GENIUS"),
              searchContextConfigId: jsonLiteral(SEARCH_CONTEXT_CONFIG_ID),
            },
            pipelineId: "search_graphql_1",
          },
        ],
      },
    ],
  };
}

interface RawSearchResult {
  sysId: string;
  table: string;
  tableLabelSingular: string;
  url: string;
  title: string;
  text: string | null;
  score: number;
}

interface RawSearchPayload {
  totalHits: number;
  searchResults: RawSearchResult[];
  filters: Array<{ sysId: string | null; label: string; count: number }>;
  // Opaque cursor for the next page (base64 of an internal offset range, e.g. "offset:0,10").
  // Empty string or absent on the last page. See scripts/probe.ts for re-verification.
  nextPaginationToken?: string | null;
}

async function postBatch(
  config: Config,
  session: GuestSession,
  query: string,
  paginationToken: string | null
): Promise<unknown> {
  const response = await fetch(new URL(BATCH_PATH, config.instanceUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: session.cookie,
      "X-UserToken": session.userToken,
    },
    body: JSON.stringify(buildBatchBody(query, session.userToken, paginationToken)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`AUTH_EXPIRED:${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`ServiceNow batch request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function extractSearchPayload(raw: unknown): RawSearchPayload {
  const body = raw as {
    serviced_requests?: Array<{ body: unknown }>;
  };
  let inner = body.serviced_requests?.[0]?.body ?? raw;
  if (typeof inner === "string") inner = JSON.parse(inner);

  const search = (
    inner as {
      result?: Array<{ executionResult?: { output?: { data?: { GlideSearch_Query?: { search?: RawSearchPayload } } } } }>;
    }
  ).result?.[0]?.executionResult?.output?.data?.GlideSearch_Query?.search;

  if (!search) {
    throw new Error("Unexpected response shape from mynow search API — run scripts/probe.ts to re-verify.");
  }
  return search;
}

interface RawFetchResult {
  results: NormalizedSearchResult[];
  totalHits: number;
  facetCounts: Array<{ label: string; count: number }>;
  nextPaginationToken: string | null;
}

async function fetchRaw(
  config: Config,
  query: string,
  paginationToken: string | null
): Promise<RawFetchResult> {
  if (!cachedSession) {
    cachedSession = await acquireGuestSession(config.instanceUrl);
  }

  let raw: unknown;
  try {
    raw = await postBatch(config, cachedSession, query, paginationToken);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("AUTH_EXPIRED")) {
      cachedSession = await acquireGuestSession(config.instanceUrl);
      raw = await postBatch(config, cachedSession, query, paginationToken);
    } else {
      throw err;
    }
  }

  const search = extractSearchPayload(raw);

  const results: NormalizedSearchResult[] = search.searchResults.map((r) => ({
    title: stripHighlight(r.title),
    snippet: r.text ? stripHighlight(r.text) : null,
    url: new URL(r.url, config.instanceUrl).toString(),
    table: r.table,
    contentTypeLabel: r.tableLabelSingular,
    score: r.score,
  }));

  for (const r of results) {
    contentTypeRegistry.set(r.table, r.contentTypeLabel);
  }
  const facetCounts = search.filters
    .filter((f) => f.sysId !== null)
    .map((f) => ({ label: f.label, count: f.count }));
  lastFacetCounts = facetCounts;
  registryUpdatedAt = Date.now();

  // Empty string / absent token means there is no next page.
  const nextPaginationToken = search.nextPaginationToken ? search.nextPaginationToken : null;

  return { results, totalHits: search.totalHits, facetCounts, nextPaginationToken };
}

export async function searchServiceNow(
  config: Config,
  params: SearchParams
): Promise<NormalizedSearchResponse> {
  let searchedQuery = params.query;
  let detectedContentType: string | null = null;
  let effectiveContentType = params.contentType ?? null;

  if (!params.contentType) {
    const intent = extractContentTypeIntent(params.query);
    if (intent.contentType) {
      searchedQuery = intent.query;
      detectedContentType = intent.contentType;
      effectiveContentType = intent.contentType;
    }
  }

  // The API pages 10 rows at a time. Jump to `offset` with a constructed token, then follow the
  // server's own nextPaginationToken to gather enough rows to satisfy `limit` (at most
  // ceil(limit / 10) requests). Using the returned token for continuation keeps us off the
  // reverse-engineered token format for everything past the initial offset jump.
  let token: string | null = params.offset > 0 ? encodeOffsetToken(params.offset) : null;

  const collected: NormalizedSearchResult[] = [];
  let totalHits = 0;
  let facetCounts: Array<{ label: string; count: number }> = [];

  while (collected.length < params.limit) {
    const page = await fetchRaw(config, searchedQuery, token);
    totalHits = page.totalHits;
    if (facetCounts.length === 0) facetCounts = page.facetCounts;
    collected.push(...page.results);
    // No more pages, or a page that can't advance us — stop rather than loop forever.
    if (!page.nextPaginationToken || page.results.length === 0) break;
    token = page.nextPaginationToken;
  }

  let results = collected;
  let contentTypeFilterDegraded = false;
  const notes: string[] = [];

  if (effectiveContentType) {
    const needle = effectiveContentType.toLowerCase();
    const filtered = results.filter(
      (r) => r.table.toLowerCase() === needle || r.contentTypeLabel.toLowerCase() === needle
    );

    // contentType filtering is still client-side over the fetched rows (no server-side facet
    // filtering has been reverse-engineered yet — see the "ServiceNow Genius Search contentType
    // Filtering Is Client-Side on a Fixed Page" Team-Brain gotcha). A query can have hundreds of
    // real matches for a content type while none land in the rows we fetched, which would otherwise
    // look identical to a genuine zero-match query. Fall back to the unfiltered rows and say so,
    // rather than silently returning an empty result set.
    if (filtered.length === 0 && totalHits > 0) {
      contentTypeFilterDegraded = true;
      notes.push(
        `${totalHits} total matches exist for "${searchedQuery}", but none of them were in the ` +
        `fetched rows for contentType "${effectiveContentType}" — this API only supports client-side ` +
        `filtering of the rows returned, not true server-side faceting. Showing unfiltered results ` +
        `instead so nothing relevant is hidden.`
      );
    } else {
      results = filtered;
    }
  }

  const paged = results.slice(0, params.limit);
  // Corpus-level signal: are there rows beyond this window? Based on totalHits so it doesn't depend
  // on the token format. (When contentType filtering is applied this still reflects the raw corpus.)
  const hasMore = params.offset + params.limit < totalHits;

  return {
    query: params.query,
    searchedQuery,
    detectedContentType,
    totalResults: totalHits,
    results: paged,
    contentTypeFilters: facetCounts,
    contentTypeFilterDegraded,
    hasMore,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}
