/** Native HTTP adapters following Hermes tools/web_tools.py and plugins/web provider contracts.
 * No Hermes runtime, model calls, credential-store reads, automatic retries or backend rescue.
 */
import { DUCKDUCKGO_URL, EXA_MCP_URL, parseDuckDuckGoResponse, parseExaResponse } from "./web-search-keyless.ts";

export const SEARCH_PROVIDERS = ["tavily", "firecrawl", "searxng", "brave", "exa", "duckduckgo"] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
type Env = Record<string, string | undefined>;
export type SearchHit = { title: string; url: string; description: string; position: number };
export type SearchResult = {
  success: true; provider: SearchProvider; query: string; data: { web: SearchHit[] }; truncated: boolean;
};
type Dependencies = { env?: Env; fetch?: typeof fetch; timeoutMs?: number };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
class SearchResponseError extends Error {}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
// Search data is untrusted; strip terminal controls before it enters the transcript/UI.
const clean = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, max) : "";

export function resolveSearchProvider(env: Env): SearchProvider {
  const explicit = env.GENERALIST_WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit !== "auto") {
    if (explicit === "brave-free") return "brave";
    if (explicit === "ddg") return "duckduckgo";
    if (SEARCH_PROVIDERS.includes(explicit as SearchProvider)) return explicit as SearchProvider;
    throw new Error("Unknown GENERALIST_WEB_SEARCH_PROVIDER. Use auto, exa, duckduckgo, tavily, firecrawl, searxng, or brave.");
  }
  // Hermes order for the supported subset: explicit credentials precede self-hosted/free tiers.
  if (env.TAVILY_API_KEY?.trim()) return "tavily";
  if (env.FIRECRAWL_API_KEY?.trim() || env.FIRECRAWL_API_URL?.trim()) return "firecrawl";
  if (env.SEARXNG_URL?.trim()) return "searxng";
  if (env.BRAVE_SEARCH_API_KEY?.trim()) return "brave";
  return "exa"; // Hermes's first public keyless tier; enabling the tool requires no setup.
}

function endpoint(base: string, path: string): URL {
  let url: URL;
  try { url = new URL(`${base.replace(/\/+$/, "")}/${path}`); }
  catch { throw new Error("Invalid web search endpoint URL."); }
  // Local HTTP is allowed for explicitly configured self-hosted services, not model-supplied URLs.
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Web search endpoint must be an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return url;
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SearchResponseError("Web search returned an empty response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SearchResponseError("Web search response exceeds 2 MiB.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function searchWeb(query: string, limit = 5, signal?: AbortSignal, deps: Dependencies = {}): Promise<SearchResult> {
  if (typeof query !== "string" || !query.trim() || query.length > 2000) throw new Error("Search query must contain 1–2000 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Search limit must be an integer from 1 to 100.");
  signal?.throwIfAborted();
  const env = deps.env ?? process.env;
  const provider = resolveSearchProvider(env);
  const keyName = { tavily: "TAVILY_API_KEY", firecrawl: "FIRECRAWL_API_KEY", brave: "BRAVE_SEARCH_API_KEY", searxng: "", exa: "", duckduckgo: "" }[provider];
  const key = env[keyName]?.trim();
  if (keyName && !key && !(provider === "firecrawl" && env.FIRECRAWL_API_URL?.trim())) throw new Error(`${keyName} is not set.`);
  if (provider === "searxng" && !env.SEARXNG_URL?.trim()) throw new Error("SEARXNG_URL is not set.");
  const headers: Record<string, string> = { Accept: "application/json" };
  let url: URL;
  let body: Record<string, unknown> | undefined;
  if (provider === "exa") {
    url = new URL(EXA_MCP_URL);
    headers.Accept = "application/json, text/event-stream";
    headers["User-Agent"] = "pi-generalist-extensions";
    body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query, numResults: limit } } };
  } else if (provider === "duckduckgo") {
    url = new URL(DUCKDUCKGO_URL);
    url.searchParams.set("q", query);
    headers.Accept = "text/html";
    headers["User-Agent"] = "pi-generalist-extensions";
  } else if (provider === "tavily") {
    url = endpoint(env.TAVILY_BASE_URL?.trim() || "https://api.tavily.com", "search");
    headers.Authorization = `Bearer ${key}`;
    body = { query, max_results: Math.min(limit, 20), include_raw_content: false, include_images: false };
  } else if (provider === "firecrawl") {
    url = endpoint(env.FIRECRAWL_API_URL?.trim() || "https://api.firecrawl.dev", "v2/search");
    if (key) headers.Authorization = `Bearer ${key}`;
    body = { query, limit, sources: ["web"] };
  } else if (provider === "brave") {
    url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 20)));
    headers["X-Subscription-Token"] = key!;
  } else {
    url = endpoint(env.SEARXNG_URL!.trim(), "search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", "1");
  }
  if (body) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let raw: string;
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal, redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Never expose vendor response bodies (may echo credentials) in persisted error results.
      throw new SearchResponseError(`Web search (${provider}) failed: HTTP ${response.status}.`);
    }
    raw = await readBody(response);
  } catch (error) {
    if (signal?.aborted) throw new Error("Web search cancelled.");
    if (timeout.aborted) throw new Error("Web search timed out.");
    if (error instanceof SearchResponseError) throw error;
    throw new Error(`Web search (${provider}) request failed.`);
  }
  requestSignal.throwIfAborted();
  let rows: unknown;
  if (provider === "exa") rows = parseExaResponse(raw);
  else if (provider === "duckduckgo") rows = parseDuckDuckGoResponse(raw);
  else {
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(raw)); }
    catch { throw new SearchResponseError("Web search returned invalid JSON."); }
    if (payload.success === false || payload.error) throw new Error(`Web search (${provider}) returned an error.`);
    if (provider === "firecrawl") {
      const data = record(payload.data);
      rows = Array.isArray(payload.data) ? payload.data : data.web ?? data.results ?? payload.web ?? payload.results;
    } else if (provider === "brave") rows = record(payload.web).results;
    else rows = payload.results;
  }
  if (!Array.isArray(rows)) throw new Error(`Web search (${provider}) returned an invalid result shape.`);
  if (provider === "searxng") rows = [...rows].sort((a, b) => (Number(record(b).score) || 0) - (Number(record(a).score) || 0));
  const hits: SearchHit[] = [];
  let bytes = 2, truncated = false; // Include array brackets and separators in the byte budget.
  for (const row of (rows as unknown[]).slice(0, limit)) {
    const r = record(row);
    // Never shorten a URL into a different, apparently valid source link.
    if (typeof r.url === "string" && r.url.length > 2048) { truncated = true; continue; }
    if (typeof r.url === "string" && /[\x00-\x1f\x7f-\x9f]/.test(r.url)) continue;
    const hit: SearchHit = { title: clean(r.title, 300), url: clean(r.url, 2048),
      description: clean(r.description ?? r.content ?? r.snippet, 1000), position: hits.length + 1 };
    try { const u = new URL(hit.url); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) continue; }
    catch { continue; }
    const size = Buffer.byteLength(JSON.stringify(hit)) + (hits.length ? 1 : 0);
    if (bytes + size > MAX_RESULT_BYTES) { truncated = true; break; }
    bytes += size;
    truncated ||= [r.title, r.url, r.description ?? r.content ?? r.snippet].some((v, i) => typeof v === "string" && v.length > [300, 2048, 1000][i]!);
    hits.push(hit);
  }
  return { success: true, provider, query: clean(query, 2000), data: { web: hits }, truncated };
}
