import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerSearchTool } from "./tools/search.js";

const config = loadConfig();

const server = new McpServer({
  name: "best-practices-mcp",
  version: "0.1.0",
});

registerSearchTool(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
