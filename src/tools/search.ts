import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { searchServiceNow } from "../servicenow/search.js";

export function registerSearchTool(server: McpServer, config: Config): void {
  server.registerTool(
    "servicenow_search",
    {
      title: "Search mynow.servicenow.com",
      description:
        "Search ServiceNow's public best-practices library (mynow.servicenow.com) across Knowledge, " +
        "Best Practices, Developer Portal docs, and other indexed content. No authentication required. " +
        "Leave contentType unset to search all sources; use the 'table' field on prior results to " +
        "discover valid contentType filter values.",
      inputSchema: {
        query: z.string().min(1).describe("Search term(s)"),
        contentType: z
          .string()
          .optional()
          .describe(
            "Optional table/source filter (e.g. 'kb_knowledge', 'sn_communities_post'). " +
              "Leave unset to search all sources."
          ),
        limit: z.number().int().min(1).max(50).optional().default(10),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    async ({ query, contentType, limit, offset }) => {
      try {
        const response = await searchServiceNow(config, {
          query,
          contentType,
          limit: limit ?? 10,
          offset: offset ?? 0,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ServiceNow search failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
