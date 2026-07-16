import type { Config } from "../config.js";
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

function buildBatchBody(query: string, userToken: string) {
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
              paginationToken: jsonLiteral(null),
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
}

async function postBatch(config: Config, session: GuestSession, query: string): Promise<unknown> {
  const response = await fetch(new URL(BATCH_PATH, config.instanceUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: session.cookie,
      "X-UserToken": session.userToken,
    },
    body: JSON.stringify(buildBatchBody(query, session.userToken)),
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
}

async function fetchRaw(config: Config, query: string): Promise<RawFetchResult> {
  if (!cachedSession) {
    cachedSession = await acquireGuestSession(config.instanceUrl);
  }

  let raw: unknown;
  try {
    raw = await postBatch(config, cachedSession, query);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("AUTH_EXPIRED")) {
      cachedSession = await acquireGuestSession(config.instanceUrl);
      raw = await postBatch(config, cachedSession, query);
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
  lastFacetCounts = search.filters
    .filter((f) => f.sysId !== null)
    .map((f) => ({ label: f.label, count: f.count }));
  registryUpdatedAt = Date.now();

  return { results, totalHits: search.totalHits };
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

  const fetched = await fetchRaw(config, searchedQuery);

  let results = fetched.results;
  let contentTypeFilterDegraded = false;
  let note: string | null = null;

  if (effectiveContentType) {
    const needle = effectiveContentType.toLowerCase();
    const filtered = results.filter(
      (r) => r.table.toLowerCase() === needle || r.contentTypeLabel.toLowerCase() === needle
    );

    // The API always returns a fixed ~10-item raw page regardless of requested limit, and this
    // filter runs client-side on that same page (no server-side facet filtering has been
    // reverse-engineered yet — see the "ServiceNow Genius Search contentType Filtering Is
    // Client-Side on a Fixed Page" Team-Brain gotcha). A query can have hundreds of real matches
    // for a content type while none of them land in that one small raw page, which would
    // otherwise look identical to a genuine zero-match query. Fall back to the unfiltered page
    // and say so, rather than silently returning an empty result set.
    if (filtered.length === 0 && fetched.totalHits > 0) {
      contentTypeFilterDegraded = true;
      note =
        `${fetched.totalHits} total matches exist for "${searchedQuery}", but none of them were in ` +
        `the raw result page for contentType "${effectiveContentType}" — this API only supports ` +
        `client-side filtering of a small fixed page, not true server-side faceting. Showing ` +
        `unfiltered results instead so nothing relevant is hidden.`;
    } else {
      results = filtered;
    }
  }

  return {
    query: params.query,
    searchedQuery,
    detectedContentType,
    totalResults: fetched.totalHits,
    results: results.slice(params.offset, params.offset + params.limit),
    contentTypeFilters: lastFacetCounts,
    contentTypeFilterDegraded,
    note,
  };
}
