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
        "discover valid contentType filter values. A natural-language content-type cue in the query " +
        "itself (e.g. 'stream connect best practices') is detected and routed to that contentType " +
        "filter automatically, with the cue phrase removed from the search text — see the response's " +
        "searchedQuery/detectedContentType fields for what was actually searched. Set contentType " +
        "explicitly to override this detection. contentType filtering, and offset-based paging, both " +
        "only apply to a small fixed raw page, not the full corpus — if a filter would return nothing " +
        "despite real matches existing (totalResults > 0), or an offset lands past the end of that " +
        "page, the response falls back to unfiltered/in-page results and sets " +
        "contentTypeFilterDegraded/offsetPaginationDegraded/note rather than silently returning empty.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search term(s)"),
        contentType: z
          .string()
          .optional()
          .describe(
            "Optional content-type filter. Values are raw internal table sysIds (e.g. " +
              "'u_hi_kb_knowledge_gsdr'), not guessable from standard ServiceNow table names — a " +
              "wrong guess silently returns zero results instead of erroring. Call " +
              "servicenow_list_content_types first to get real values. Leave unset to search all sources."
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
