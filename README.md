# best-practices-mcp

MCP server exposing a `servicenow_search` tool that searches `mynow.servicenow.com` —
ServiceNow's public best-practices library/landing page — across content types (Best
Practices, Product Documentation, Developer Portal docs, Now Community posts, and more).

## No authentication required

`mynow.servicenow.com` is a public site — there's no login, token, or API key needed. It's
not a traditional SSO-protected ServiceNow instance; it's a public-facing Now Experience app
running in "Genius Search" / guest-session mode.

There's also no public, documented REST API for its search — it's reverse-engineered from a
Playwright network capture of the site's own search UI (see `scripts/probe.ts` and
`src/servicenow/search.ts` for the confirmed request/response shape). The flow:

1. `GET` any page on the site → returns a guest session cookie plus a CSRF token embedded in
   the HTML as `window.g_ck`.
2. `POST /api/now/v1/batch`, wrapping a GraphQL call to the site's Genius Search data broker,
   using that cookie + token.
3. Parse `result[0].executionResult.output.data.GlideSearch_Query.search` for results, facets,
   and total hit count.

This was confirmed with a **cold, browser-free curl round-trip** (no Playwright, no reused
session) — genuinely unauthenticated, not just working because of a live browser session.

**If search ever stops working**, the site's frontend likely changed one of the fixed config
IDs in `src/servicenow/search.ts` (`SEARCH_DEFINITION_SYS_ID`, `SEARCH_CONTEXT_CONFIG_ID`,
`SEARCH_EVAM_CONFIG_ID`). Re-discover them with a fresh Playwright capture filtered to
`xhr`/`fetch` traffic (write to a file, grep it — never dump raw capture output into a
conversation) rather than guessing. Then re-run `npm run probe` to confirm.

## Development

```bash
npm install
npm run dev            # run the server directly with tsx (stdio transport)
npm run build           # compile to dist/
npm start                # run compiled dist/index.js
npm run probe -- "some query"   # verify the live search flow still works
```

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npm run dev
```

## Using with Claude Code / Claude Desktop

```bash
claude mcp add --scope user best-practices-mcp -- node "C:/dev/best-practices-mcp/dist/index.js"
```

No environment variables are required — `SN_INSTANCE_URL` defaults to
`https://mynow.servicenow.com` and only needs overriding if pointing at a different instance.

## Known limitations

- `limit`/`offset` are applied to whatever the API returns per call (observed page size: 10).
  True pagination via the API's own `paginationToken` isn't wired up yet — fetching results
  beyond the first page isn't currently supported.
- `contentType` filters client-side by matching the result's own `table` or content-type label
  — there's no separate discovery tool for valid values yet. An unfiltered search's results
  carry their own `table`/`contentTypeLabel`, which is enough to learn valid filters
  organically; `contentTypeFilters` in the response also lists all available content types with
  live counts for the current query.
