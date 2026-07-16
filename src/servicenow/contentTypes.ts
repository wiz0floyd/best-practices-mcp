import type { Config } from "../config.js";
import {
  getContentTypeRegistryUpdatedAt,
  getLastFacetCounts,
  getObservedContentTypes,
  searchServiceNow,
} from "./search.js";

export interface ContentType {
  table: string;
  label: string;
}

export interface ContentTypeListing {
  contentTypes: ContentType[];
  facetCounts: Array<{ label: string; count: number }>;
  cachedAt: string | null;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Broad terms picked to span the site's known facets (Knowledge, Product Docs, Developer Portal,
 * Community, University, dotcom) so a cold cache discovers a reasonable spread of (table, label)
 * pairs in one sweep. Each query's response page is fixed at 10 results, so no single term
 * surfaces every content type — this is a best-effort warm-up, not an exhaustive enumeration.
 */
const WARMUP_QUERIES = ["servicenow", "incident", "integration", "developer", "training", "security"];

async function warmUp(config: Config): Promise<void> {
  await Promise.all(WARMUP_QUERIES.map((term) => searchServiceNow(config, { query: term, limit: 10, offset: 0 })));
}

export async function listContentTypes(
  config: Config,
  opts: { refresh?: boolean } = {}
): Promise<ContentTypeListing> {
  const updatedAt = getContentTypeRegistryUpdatedAt();
  const stale = updatedAt === null || Date.now() - updatedAt > CACHE_TTL_MS;

  if (opts.refresh || stale) {
    await warmUp(config);
  }

  const cachedAt = getContentTypeRegistryUpdatedAt();
  return {
    contentTypes: getObservedContentTypes().sort((a, b) => a.label.localeCompare(b.label)),
    facetCounts: getLastFacetCounts(),
    cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null,
  };
}
