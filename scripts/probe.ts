/**
 * Standalone re-verification probe — NOT part of the MCP server.
 *
 * mynow.servicenow.com's search is genuinely unauthenticated but reverse-engineered (there's no
 * public API doc for it). Run this anytime search results look wrong to confirm the flow still
 * works: GET a page for a guest session (cookie + window.g_ck) -> POST /api/now/v1/batch wrapping
 * a GraphQL databroker call -> parse GlideSearch_Query.search. If this script starts failing,
 * the site's frontend likely changed its config IDs (searchContextConfigId /
 * searchEvamConfigId / definitionSysId in src/servicenow/search.ts) — re-discover them with a
 * fresh Playwright network capture (filtered to xhr/fetch, written to a file, never dumped raw
 * into a conversation) rather than guessing.
 *
 * Usage: npm run probe -- "some search term"
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { searchServiceNow } from "../src/servicenow/search.js";

async function main() {
  const query = process.argv[2] ?? "stream connect";
  const config = loadConfig();

  console.log(`Searching "${query}" against ${config.instanceUrl} (no credentials)...`);
  const result = await searchServiceNow(config, { query, limit: 10, offset: 0 });

  console.log(`totalResults: ${result.totalResults}`);
  console.log(`returned: ${result.results.length}`);
  console.log(`hasMore: ${result.hasMore}`);
  console.log("content type filters:", result.contentTypeFilters.map((f) => `${f.label} (${f.count})`).join(", "));
  console.log("\nFirst few titles:");
  for (const r of result.results.slice(0, 5)) {
    console.log(`  - [${r.contentTypeLabel}] ${r.title} (score ${r.score.toFixed(1)})`);
  }

  // Re-verify offset paging: page 2 should differ from page 1 with a stable totalResults.
  if (result.hasMore) {
    const page2 = await searchServiceNow(config, { query, limit: 10, offset: 10 });
    const ids1 = result.results.map((r) => r.url).join(",");
    const ids2 = page2.results.map((r) => r.url).join(",");
    console.log(
      `\nPage 2 (offset=10): returned ${page2.results.length}, totalResults ${page2.totalResults} ` +
      `(stable: ${page2.totalResults === result.totalResults}), differs from page 1: ${ids1 !== ids2}, ` +
      `hasMore: ${page2.hasMore}`
    );
  }

  mkdirSync(".probe-output", { recursive: true });
  writeFileSync(".probe-output/last-result.json", JSON.stringify(result, null, 2), "utf-8");
  console.log("\nFull normalized result written to .probe-output/last-result.json");
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
