import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { listContentTypes } from "../servicenow/contentTypes.js";

export function registerContentTypesTool(server: McpServer, config: Config): void {
  server.registerTool(
    "servicenow_list_content_types",
    {
      title: "List mynow.servicenow.com content types",
      description:
        "List content-type values for servicenow_search's contentType filter: raw internal table " +
        "identifiers (e.g. 'u_hi_kb_knowledge_gsdr') paired with their human-readable label. These " +
        "cannot be guessed from standard ServiceNow table names (e.g. 'kb_knowledge' is wrong) — a " +
        "wrong guess silently returns zero results instead of erroring. Backed by a cache built " +
        "from real search traffic plus a warm-up sweep on first use or once the cache is more than " +
        "6 hours old; set refresh to force a fresh sweep.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force a fresh warm-up sweep instead of using the cached content types."),
      },
    },
    async ({ refresh }) => {
      try {
        const response = await listContentTypes(config, { refresh: refresh ?? false });
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Content type discovery failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
