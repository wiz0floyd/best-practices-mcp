import type { Config } from "../config.js";
import { ServiceNowClient } from "./client.js";
import type { NormalizedSearchResponse, NormalizedSearchResult, SearchParams } from "../types.js";

/**
 * NOTE: This normalization is written against the commonly-documented shape of
 * ServiceNow's Global Search REST endpoint (grouped results per source/table),
 * but has NOT been confirmed against a live mynow.servicenow.com response.
 * Run scripts/probe.ts against a real instance and compare its output to the
 * field-name guesses below before relying on this in production. Parsing is
 * intentionally defensive: an unexpected group/result shape is skipped with a
 * warning rather than failing the whole call.
 */

interface RawResultCandidate {
  [key: string]: unknown;
}

function firstString(obj: RawResultCandidate, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function resolveUrl(instanceUrl: string, maybeUrl: string): string {
  try {
    return new URL(maybeUrl, instanceUrl).toString();
  } catch {
    return maybeUrl;
  }
}

export async function searchServiceNow(
  config: Config,
  params: SearchParams
): Promise<NormalizedSearchResponse> {
  const client = new ServiceNowClient(config);
  const warnings: string[] = [];

  const queryParams: Record<string, string> = {
    sysparm_search: params.query,
    sysparm_search_source: "global",
  };
  if (params.contentType) {
    queryParams.sysparm_search_source_type = params.contentType;
  }

  const raw = (await client.getJson("/api/now/globalsearch/search", queryParams)) as RawResultCandidate;

  const resultRoot = (raw.result ?? raw) as RawResultCandidate;
  const groups = (resultRoot.groups ?? resultRoot.results ?? []) as unknown[];

  if (!Array.isArray(groups) || groups.length === 0) {
    warnings.push(
      "No result groups found in response — either there were no matches, or the response shape " +
        "didn't match the expected 'result.groups[]' structure. Inspect scripts/probe.ts output to confirm."
    );
  }

  const results: NormalizedSearchResult[] = [];

  for (const group of groups) {
    if (!group || typeof group !== "object") {
      warnings.push("Skipped a result group that was not an object.");
      continue;
    }
    const g = group as RawResultCandidate;

    const table = firstString(g, ["name", "table", "source"]) ?? "unknown";
    const contentTypeLabel = firstString(g, ["label", "displayName", "title"]) ?? table;

    const records = (g.results ?? g.records ?? []) as unknown[];
    if (!Array.isArray(records)) {
      warnings.push(`Group "${contentTypeLabel}" had no parseable results array.`);
      continue;
    }

    if (params.contentType && table !== params.contentType && contentTypeLabel !== params.contentType) {
      continue;
    }

    for (const record of records) {
      if (!record || typeof record !== "object") {
        warnings.push(`Skipped a non-object result record in group "${contentTypeLabel}".`);
        continue;
      }
      const r = record as RawResultCandidate;

      const title = firstString(r, ["title", "name", "short_description", "text"]);
      if (!title) {
        warnings.push(`Skipped a result in "${contentTypeLabel}" with no recognizable title field.`);
        continue;
      }

      const urlValue = firstString(r, ["url", "recordUrl", "link", "sys_id"]);
      results.push({
        title,
        snippet: firstString(r, ["snippet", "description", "excerpt"]) ?? null,
        url: urlValue ? resolveUrl(config.instanceUrl, urlValue) : config.instanceUrl,
        table,
        contentTypeLabel,
      });
    }
  }

  const limited = results.slice(params.offset, params.offset + params.limit);

  return {
    query: params.query,
    totalResults: typeof resultRoot.resultsCount === "number" ? (resultRoot.resultsCount as number) : null,
    results: limited,
    warnings,
  };
}
