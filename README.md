# best-practices-mcp

MCP server exposing a `servicenow_search` tool that searches `mynow.servicenow.com`
(an internal ServiceNow instance) across content types — Knowledge, Community,
People, Catalog, and anything else Global Search indexes — via a single unfiltered
or filtered query.

## Status: unverified against a live instance

This server was built without credentials for `mynow.servicenow.com`. The response
normalization in `src/servicenow/search.ts` is written against the commonly
documented shape of ServiceNow's Global Search REST endpoint
(`GET /api/now/globalsearch/search`), but **that shape has not been confirmed**.

**Before relying on this server, run the probe:**

```bash
npm install
SN_AUTH_MODE=bearer SN_BEARER_TOKEN=... npm run probe -- "stream connect"
```

This hits the real endpoint, writes the raw response to `.probe-output/`, and prints
the field-name shape so you can compare it against the guesses in `search.ts`
(group/result field names, pagination params, total-count field). Fix up
`src/servicenow/search.ts` if the real shape differs — it's written defensively
(skips unparseable groups/records with a warning instead of throwing) so partial
mismatches degrade gracefully rather than failing outright.

## Auth

Auth is pluggable via `SN_AUTH_MODE` — pick whichever mechanism you actually have
access to for `mynow.servicenow.com`, since that wasn't settled at build time:

| `SN_AUTH_MODE` | Required env vars | Notes |
|---|---|---|
| `bearer` | `SN_BEARER_TOKEN` | OAuth access token or personal API token. Preferred if available. |
| `basic` | `SN_USERNAME`, `SN_PASSWORD` | HTTP Basic with a personal account/service account. |
| `cookie` | `SN_SESSION_COOKIE` (optional `SN_USER_TOKEN`) | Reuses a captured browser SSO session cookie. Most fragile — breaks on session expiry, MFA re-prompts, or SSO config changes. Use only if no API credentials are available. |

Copy `.env.example` to `.env` and fill in the vars for your chosen mode.
Missing/invalid vars fail fast at startup with a clear error, not on first tool call.

## Development

```bash
npm install
npm run dev      # run the server directly with tsx (stdio transport)
npm run build    # compile to dist/
npm start        # run compiled dist/index.js
```

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npm run dev
```

This opens a local UI where you can call `servicenow_search` directly and inspect
raw tool responses without wiring up Claude Desktop/Code first.

## Using with Claude Code / Claude Desktop

Add to your MCP client config (paths/env vary by client):

```json
{
  "mcpServers": {
    "best-practices-mcp": {
      "command": "node",
      "args": ["C:/dev/best-practices-mcp/dist/index.js"],
      "env": {
        "SN_INSTANCE_URL": "https://mynow.servicenow.com",
        "SN_AUTH_MODE": "bearer",
        "SN_BEARER_TOKEN": "..."
      }
    }
  }
}
```

## Known limitations / deferred

- No `servicenow_list_search_sources` discovery tool yet — deferred until the
  probe confirms whether ServiceNow exposes a cheap way to enumerate valid
  `contentType` filter values. In the meantime, an unfiltered `servicenow_search`
  call returns each result's own `table`/`contentTypeLabel`, which is enough for
  the caller to learn valid filter values organically.
- `limit`/`offset` are applied client-side after fetching whatever the API
  returns by default — real server-side pagination params are unconfirmed
  (see probe step above).
