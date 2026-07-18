import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { downloadServiceNowDocument } from "../servicenow/download.js";

export function registerDownloadTool(server: McpServer, config: Config): void {
  server.registerTool(
    "servicenow_download_document",
    {
      title: "Download a mynow.servicenow.com document",
      description:
        "Download the file behind a servicenow_search result's url (file-backed content types " +
        "only — e.g. presentations, workbooks, docs; not plain Knowledge articles). Requires a " +
        "session captured beforehand by running `npm run login` in a terminal (opens a real " +
        "browser window for you to complete ServiceNow ID / Okta login by hand) — this tool never " +
        "launches a browser itself. If no session has been captured, or it has expired, this " +
        "returns an error telling you to run `npm run login` again.",
      inputSchema: {
        url: z.string().describe("The url field from a servicenow_search result."),
        sysId: z.string().optional().describe("Unused; accepted for convenience when passing a result object through."),
      },
    },
    async ({ url }) => {
      try {
        const doc = await downloadServiceNowDocument(config, url);
        return {
          content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const friendly = message.startsWith("AUTH_EXPIRED")
          ? "No valid ServiceNow session — run `npm run login` in a terminal, then try again."
          : `ServiceNow document download failed: ${message}`;
        return {
          content: [{ type: "text", text: friendly }],
          isError: true,
        };
      }
    }
  );
}
