import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const FETCH_TIMEOUT_MS = 30_000;

// Minutes-scale, separate from FETCH_TIMEOUT_MS — a human has to actually complete SSO/MFA by
// hand, not a machine-speed round trip.
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

// Anchor default paths to the project root, not process.cwd() — when this server is spawned as
// an MCP server (vs run directly from a terminal), the host controls the working directory, which
// is often NOT this repo. A bare relative default would then silently resolve to the wrong place
// (confirmed live: existsSync(".auth/...") returned false under the MCP host even though the file
// was genuinely sitting in the repo's .auth/ directory). Explicit env-var overrides are left as
// plain relative-to-cwd paths, matching normal env-var expectations for users who set them.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  instanceUrl: string;
  authStatePath: string;
  downloadDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    instanceUrl: env.SN_INSTANCE_URL ?? "https://mynow.servicenow.com",
    authStatePath: env.SN_AUTH_STATE_PATH ?? resolve(PROJECT_ROOT, ".auth/servicenow-storage-state.json"),
    downloadDir: env.SN_DOWNLOAD_DIR ?? resolve(PROJECT_ROOT, ".auth/downloads"),
  };
}
