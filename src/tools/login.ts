import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getLoginStatus, startBackgroundLogin } from "../servicenow/loginState.js";

export function registerLoginTool(server: McpServer, config: Config): void {
  server.registerTool(
    "servicenow_login",
    {
      title: "Start a ServiceNow SSO login",
      description:
        "Use this when servicenow_download_document fails with an AUTH_EXPIRED / no-session error " +
        "and you need a fresh one. Opens a real, visible browser window on the machine running this " +
        "MCP server for a human to complete ServiceNow ID / Okta login by hand, then captures the " +
        "resulting SSO session cookies to disk for servicenow_download_document to reuse — it does " +
        "NOT hand back a token directly. This returns immediately; the login itself can take minutes " +
        "(SSO/MFA is done by a human, not this tool). Poll servicenow_login_status to see when it's " +
        "done, then retry the download.",
      inputSchema: {},
    },
    async () => {
      const result = startBackgroundLogin(config);
      const message =
        result.status === "running" && result.startedAt
          ? "A browser window has opened (or one was already in progress) — complete the ServiceNow " +
            "ID / Okta login by hand. Check servicenow_login_status for progress, then retry your " +
            "download once it reports success."
          : `Unexpected state: ${JSON.stringify(result)}`;
      return {
        content: [{ type: "text", text: message }],
      };
    }
  );
}

export function registerLoginStatusTool(server: McpServer, config: Config): void {
  server.registerTool(
    "servicenow_login_status",
    {
      title: "Check ServiceNow login status",
      description:
        "Check whether a servicenow_login capture is still running, finished, or failed, and " +
        "whether a session file currently exists on disk (with its age). Use this after calling " +
        "servicenow_login to know when it's safe to retry servicenow_download_document.",
      inputSchema: {},
    },
    async () => {
      const status = getLoginStatus(config);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  );
}
