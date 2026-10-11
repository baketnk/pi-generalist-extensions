# Web search

The bundle includes an optional `web_search` tool based on Hermes's generic
search schema, HTTP provider conventions (`tools/web_tools.py` and
`plugins/web/{tavily,firecrawl,searxng,brave_free}/provider.py`), and public Exa
keyless transport (`plugins/web/keyless_mcp.py`). DuckDuckGo uses its public
Lite search page rather than Hermes's Python DDGS subprocess. All adapters
are native TypeScript; Hermes and its Python packages are not required.

## Setup

No API key, account, adapter installation, or self-hosted service is required.
Enable **Web search** in `/generalist`, or run `/generalist websearch on`.
Without configured credentials, it uses public keyless Exa search—the first
entry in Hermes's keyless preference order.

DuckDuckGo is also available without credentials:

```sh
GENERALIST_WEB_SEARCH_PROVIDER=duckduckgo pi
```

Both are free public endpoints with service-side limits. A rate limit or DDG
bot challenge is reported as an error, not an empty result or a silent reroute.

Supported backends (environment belongs to the process launching Pi):

| Provider | Environment | Endpoint |
| --- | --- | --- |
| Exa keyless | none; or `GENERALIST_WEB_SEARCH_PROVIDER=exa` | `https://mcp.exa.ai/mcp` |
| DuckDuckGo | `GENERALIST_WEB_SEARCH_PROVIDER=duckduckgo` (`ddg` alias) | `https://lite.duckduckgo.com/lite/` |
| Tavily | `TAVILY_API_KEY` | `https://api.tavily.com/search` |
| Firecrawl | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev/v2/search` |
| SearXNG | `SEARXNG_URL` (your instance base URL) | `<base>/search?format=json` |
| Brave | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com/res/v1/web/search` |

Optional keyed setup, if you later want it:

```sh
export TAVILY_API_KEY='your-key'
pi
```

Run `/generalist`, select **Web search**, and switch it on; or run
`/generalist websearch on`. `/generalist websearch off` disables it. The choice
is branch-local and restores on resume, reload, and tree navigation. Press
`Ctrl+S` in `/generalist` to save it as a default for new sessions. The toggle
is independent of personality, memory, and reflective continuity. No search
requests run during startup, enabling, or saving.

`/websearch on|off|status` and the `--websearch` CLI seed are also available.
Saved branch decisions take precedence over defaults/CLI seeds, following the
existing Generalist toggle policy. Backend settings and keys are not stored in
the Generalist defaults or session toggle entries.

## Backend selection

With `GENERALIST_WEB_SEARCH_PROVIDER` unset or `auto`, choose the first
configured backend: Tavily → Firecrawl → SearXNG → Brave → public keyless Exa.
Set it explicitly to `exa`, `duckduckgo`, `tavily`, `firecrawl`, `searxng`, or
`brave` (`brave-free` is an alias) to force one. The Exa adapter always uses the
public keyless endpoint, not `EXA_API_KEY`. A forced keyed backend missing its
configuration fails; there is no failure-time fallback or automatic retry.
Keyed search APIs may have usage charges. Public keyless requests send the
query, not model/session identifiers or credentials.

`TAVILY_BASE_URL` overrides Tavily's base URL. `FIRECRAWL_API_URL` overrides
Firecrawl's base URL and permits a keyless self-hosted instance. Base URLs may
include a path prefix; do not include `/search` or `/v2/search`. HTTP(S) only,
without URL credentials, query strings, or fragments. Redirects are rejected.
These endpoints come from the launch environment, never tool arguments. Use
HTTPS for remote services carrying API keys. SearXNG must enable JSON output.

This is a focused port, not Hermes's entire web stack: no managed Nous gateway,
provider-rescue ring, DDGS/Python dependencies, MCP discovery, extraction, result cache, or
Hermes configuration/credential-store imports.

## Tool contract

```json
{"query":"site:example.com exact topic","limit":5}
```

`query` is nonblank and at most 2000 characters; operators are passed through.
`limit` defaults to 5 and accepts integers 1–100. Tavily and Brave cap their
request at 20; SearXNG returns the first page, sorted by score. DuckDuckGo Lite
also returns only its first page (often ten results), without pagination. Limits are
maximums, not guaranteed counts.

Success details follow Hermes's common envelope, with provider/query and
truncation metadata added:

```json
{"success":true,"provider":"tavily","query":"topic","data":{"web":[{"title":"Title","url":"https://example.com/","description":"Snippet","position":1}]},"truncated":false}
```

Readable output is the default; `/generalist output on` selects JSON. Results
are snippets, not full-page extraction. They are external data, not agent
instructions; verify important claims and cite source URLs.

Requests have a 30-second deadline, including body reads, and honor the tool
abort signal. Responses are limited to 2 MiB. Normalized results are bounded
to 32 KiB total, with title/URL/description caps of 300/2048/1000 characters;
output is capped at 48 KiB/1800 lines. Terminal controls are stripped; unsafe
URL schemes and URLs containing credentials or terminal controls are dropped;
oversized URLs are dropped rather than shortened into a different source link. Truncation is
reported. HTTP and provider failures throw so Pi marks the result as an error;
vendor error bodies are not echoed into transcripts.

The extension registers a fixed tool definition and changes active-tool state
only on explicit toggle/branch restore. It does not inject or rewrite context
on search calls or ordinary turns. Activation is a tool-set transition owned
by Pi; provider-specific cache behavior at that transition belongs to Pi.
