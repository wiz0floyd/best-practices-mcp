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

## Pagination

The API returns a **fixed 10 rows per request** and pages via an opaque
`paginationToken` (base64 of an internal offset breadcrumb, e.g. `offset:0,10`). Use `offset`
to page through the full corpus and `limit` to control how many rows you get back:

- `offset` is a row index into the full corpus (`offset=10` → second page, `offset=20` → third,
  etc.). It's implemented by constructing a token that jumps directly to that row — the server
  doesn't validate the breadcrumb, so any offset is random-accessible in a single request.
- `limit` (1–50) can exceed the 10-row page size; the server is paged internally
  (`ceil(limit / 10)` requests, following the API's own returned token after the initial jump) to
  gather that many rows.
- `hasMore` in the response is true when more results exist beyond `offset + limit`
  (`offset + limit < totalResults`).

Because the offset jump relies on the reverse-engineered token format, `npm run probe` exercises
offset paging end-to-end — if the encoding ever changes, re-discover it from a fresh capture (see
below) rather than guessing.

## Downloading documents

Search itself needs no auth, but the actual file behind a file-backed result (presentations,
workbooks, docs) is gated behind a real ServiceNow ID / Okta SSO login — confirmed live via
Playwright (see `scripts/probe-headed-login.ts`).

1. **`npm run login`** — opens a real, visible browser window. Complete the ServiceNow ID / Okta
   login by hand; the script detects when you're back on the instance and saves the session to
   `.auth/servicenow-storage-state.json` (gitignored — this is a live credential). This is a
   standalone script, never an MCP tool call, since a headed browser waiting minutes on human
   SSO/MFA input has no business running inside a tool-call timeout.
2. **`servicenow_download_document`** (MCP tool) — pass a `servicenow_search` result's `url`. No
   browser is launched here: it replays the captured session's cookies against the record's
   classic XML export view (`<table>.do?...&XML`, confirmed to accept cookie replay outside the
   browser), extracts the record's own file-location field, and fetches that file directly (often
   a separate public CDN, no ServiceNow auth needed for that hop). If the session is missing or
   has expired, it returns a clear error telling you to re-run `npm run login` — it never launches
   a browser itself.

## Known limitations

- `contentType` filters client-side by matching the result's own `table` or content-type label
  — there's no separate discovery tool for valid values yet. An unfiltered search's results
  carry their own `table`/`contentTypeLabel`, which is enough to learn valid filters
  organically; `contentTypeFilters` in the response also lists all available content types with
  live counts for the current query.
