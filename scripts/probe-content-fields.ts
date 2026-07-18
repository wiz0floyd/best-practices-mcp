/**
 * Stage 1a spike (see feature plan for "load content after searching") — NOT part of the MCP
 * server. Tests two independent questions about mynow's Genius Search databroker for
 * TEXT/ARTICLE-style results only (not file-backed presentations/workbooks/docs, which this
 * API almost certainly can't help with regardless of outcome — see Stage 1b):
 *
 *   (a) Field richness: does requesting extra fields (body/content/html/short_description/
 *       description) beyond the default ["title","text","sys_id"] return full-length article
 *       content instead of just a short snippet?
 *   (b) By-identity targeting: buildBatchBody's inputs are searchTerm/facetFilters/searchFilters/
 *       paginationToken — it's a *search*, not a get-by-id. sys_id only ever appears in the
 *       *output*. This tests whether a specific previously-seen record can be deterministically
 *       retargeted (searchTerm=sysId, searchTerm=exact title, or a guessed sys_id filter shape),
 *       which is required for a get_content({table, sysId}) tool to mean what its schema promises.
 *
 * Usage: npm run probe-content-fields
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { searchServiceNow } from "../src/servicenow/search.js";
import { fetchRawSearchPayloadForProbe } from "../src/servicenow/search.js";

const EXPANDED_FIELDS = [
  "title",
  "text",
  "sys_id",
  "body",
  "content",
  "html",
  "short_description",
  "description",
];

function fieldLengths(result: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const field of EXPANDED_FIELDS) {
    const value = result[field];
    out[field] = typeof value === "string" ? value.length : value == null ? null : -1;
  }
  return out;
}

async function main() {
  const config = loadConfig();
  const findings: Record<string, unknown> = {};

  // Find a real text/article-style result to use as the target for both tests.
  console.log('Searching "stream connect" to find an article-style (Now Support) result...');
  const baseline = await searchServiceNow(config, { query: "stream connect", limit: 10, offset: 0 });
  const target = baseline.results.find((r) => r.table === "u_hi_kb_knowledge_gsdr") ?? baseline.results[0];
  console.log(`Target: "${target.title}" (table=${target.table}, sysId=${target.sysId}), snippet length=${target.snippet?.length ?? 0}`);
  findings.target = target;

  // --- Test A: field richness ---
  console.log("\n--- Test A: requesting expanded field superset ---");
  const expandedPayload = await fetchRawSearchPayloadForProbe(config, "stream connect", EXPANDED_FIELDS);
  const expandedTarget = (expandedPayload.searchResults as unknown as Record<string, unknown>[]).find(
    (r) => r.sysId === target.sysId
  );
  const lengths = expandedTarget ? fieldLengths(expandedTarget) : null;
  console.log("Field lengths on target result (null = absent, -1 = non-string):", lengths);
  console.log("Raw expanded target object:", JSON.stringify(expandedTarget, null, 2));
  findings.testA_fieldLengths = lengths;
  findings.testA_rawExpandedTarget = expandedTarget ?? null;

  // --- Test B: by-identity targeting ---
  console.log("\n--- Test B: by-identity retargeting ---");
  const attempts: Array<{ label: string; searchTerm: string }> = [
    { label: "searchTerm=sysId", searchTerm: target.sysId },
    { label: "searchTerm=exact title", searchTerm: target.title },
  ];
  const testBResults: Record<string, unknown> = {};
  for (const attempt of attempts) {
    const result = await searchServiceNow(config, { query: attempt.searchTerm, limit: 5, offset: 0 });
    const topResult = result.results[0];
    const matchesTarget = topResult?.sysId === target.sysId;
    const isOnlyResult = result.totalResults === 1;
    console.log(
      `  [${attempt.label}] top result sysId=${topResult?.sysId ?? "none"} matchesTarget=${matchesTarget} ` +
      `totalResults=${result.totalResults} isOnlyResult=${isOnlyResult}`
    );
    testBResults[attempt.label] = { topResultSysId: topResult?.sysId ?? null, matchesTarget, totalResults: result.totalResults };
  }
  findings.testB_byIdentityAttempts = testBResults;

  mkdirSync(".probe-output", { recursive: true });
  writeFileSync(".probe-output/content-field-spike.json", JSON.stringify(findings, null, 2), "utf-8");
  console.log("\nFull findings written to .probe-output/content-field-spike.json");
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
