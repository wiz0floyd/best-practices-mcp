/**
 * Standalone verification probe — NOT part of the MCP server.
 *
 * We have not verified the actual Global Search REST endpoint or response
 * shape against a live mynow.servicenow.com instance (no credentials were
 * available when this server was designed). Run this script once real
 * credentials exist, BEFORE trusting src/servicenow/search.ts's normalization
 * logic — it assumes a shape that needs to be confirmed here first.
 *
 * Usage:
 *   SN_AUTH_MODE=bearer SN_BEARER_TOKEN=... npm run probe -- "stream connect"
 *   SN_AUTH_MODE=cookie SN_SESSION_COOKIE="glide_user_route=...; JSESSIONID=..." npm run probe
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createAuthStrategy } from "../src/servicenow/auth.js";

function describeShape(value: unknown, depth = 0, maxDepth = 3): unknown {
  if (depth >= maxDepth) return typeof value;
  if (Array.isArray(value)) {
    return value.length > 0 ? [describeShape(value[0], depth + 1, maxDepth)] : [];
  }
  if (value && typeof value === "object") {
    const shape: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      shape[key] = describeShape((value as Record<string, unknown>)[key], depth + 1, maxDepth);
    }
    return shape;
  }
  return typeof value;
}

async function main() {
  const query = process.argv[2] ?? "stream connect";
  const config = loadConfig();
  const auth = createAuthStrategy(config);

  const url = new URL("/api/now/globalsearch/search", config.instanceUrl);
  url.searchParams.set("sysparm_search", query);
  url.searchParams.set("sysparm_search_source", "global");

  console.log(`GET ${url.toString()}`);
  console.log(`Auth mode: ${auth.mode}`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...auth.getAuthHeaders(),
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  console.log(`Status: ${response.status}`);
  console.log(`Content-Type: ${contentType}`);

  const bodyText = await response.text();

  mkdirSync(".probe-output", { recursive: true });
  writeFileSync(".probe-output/raw-response.txt", bodyText, "utf-8");
  console.log(`Raw response body written to .probe-output/raw-response.txt (${bodyText.length} bytes)`);

  if (!contentType.includes("application/json")) {
    console.error(
      "\n[WARNING] Response is not JSON. This usually means an SSO login redirect page " +
        "came back instead of search results (expired/invalid cookie, or bearer/basic auth " +
        "not accepted by this instance). Inspect .probe-output/raw-response.txt to confirm."
    );
    return;
  }

  const json = JSON.parse(bodyText);
  console.log("\nTop-level shape (field names + nesting, values truncated):");
  console.log(JSON.stringify(describeShape(json), null, 2));

  writeFileSync(".probe-output/parsed-response.json", JSON.stringify(json, null, 2), "utf-8");
  console.log("\nFull parsed JSON written to .probe-output/parsed-response.json for manual inspection.");
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exitCode = 1;
});
