/**
 * Standalone interactive login. Opens a real, visible browser window for you to complete
 * ServiceNow ID / Okta login by hand, then persists the resulting session for
 * servicenow_download_document to reuse. Deliberately NOT an MCP tool — a headed browser waiting
 * minutes on human SSO/MFA input has no business running inside a tool-call timeout.
 *
 * Usage: npm run login
 */
import { loadConfig } from "../src/config.js";
import { captureServiceNowSession } from "../src/servicenow/login.js";

async function main() {
  const config = loadConfig();
  await captureServiceNowSession(config);
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
