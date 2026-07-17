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

// Tracked separately from search.ts's registryUpdatedAt, which is bumped by every ordinary
// search — gating staleness on that would mean routine traffic keeps the cache looking "fresh"
// and the deliberate broad sweep below would rarely, if ever, re-run. This timestamp only
// advances when the sweep itself completes.
let lastWarmUpAt: number | null = null;
// Concurrent stale-cache callers share one in-flight sweep instead of each firing their own
// full WARMUP_QUERIES fan-out.
let warmUpPromise: Promise<void> | null = null;

async function warmUp(config: Config): Promise<void> {
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    await Promise.all(WARMUP_QUERIES.map((term) => searchServiceNow(config, { query: term, limit: 10, offset: 0 })));
    lastWarmUpAt = Date.now();
  })();

  try {
    await warmUpPromise;
  } finally {
    warmUpPromise = null;
  }
}

export async function listContentTypes(
  config: Config,
  opts: { refresh?: boolean } = {}
): Promise<ContentTypeListing> {
  const stale = lastWarmUpAt === null || Date.now() - lastWarmUpAt > CACHE_TTL_MS;

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
