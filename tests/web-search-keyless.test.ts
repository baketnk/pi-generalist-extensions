import { expect, test } from "bun:test";
import { searchWeb } from "../lib/web-search.ts";
import { DUCKDUCKGO_URL, EXA_MCP_URL, parseDuckDuckGoResponse, parseExaResponse } from "../lib/web-search-keyless.ts";

const text = "Title: Synthetic Docs\nURL: https://example.com/docs?a=1&b=2\nPublished: N/A\nAuthor: N/A\nHighlights:\nA synthetic snippet.\nSecond line.\n\n---\n\nTitle: Second\nURL: https://example.com/second\nHighlights: Inline snippet\nAuthor: Not part of snippet\n";
const envelope = (text: string) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
const html = `<!doctype html><html><table>
<tr><td>1.</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1%26b%3D2&amp;rut=hash" class='result-link'>Synthetic <b>Docs</b> &amp; &#x1F333;</a></td></tr>
<tr><td></td><td class="result-snippet">A <b>synthetic</b> snippet &quot;test&quot; &#39;quoted&#39; &#160; spaced.</td></tr>
<tr><td><a class="irrelevant" href="https://example.com/not-a-result">Ignore navigation</a></td></tr>
<tr><td><a class="result-link" href="https://example.com/second">Second</a></td></tr>
<tr><td class='result-snippet'>Another &lt;snippet&gt;.</td></tr>
</table></html>`;
function transport(body: string, contentType: string, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("Exa keyless MCP JSON and SSE envelopes normalize Hermes's formatted search blocks", () => {
  const expected = [
    { title: "Synthetic Docs", url: "https://example.com/docs?a=1&b=2", description: "A synthetic snippet. Second line." },
    { title: "Second", url: "https://example.com/second", description: "Inline snippet" },
  ];
  expect(parseExaResponse(JSON.stringify(envelope(text)))).toEqual(expected);
  expect(parseExaResponse(`: keepalive\r\nevent: message\r\ndata:${JSON.stringify(envelope(text))}\r\n\r\n`)).toEqual(expected);
  const json = JSON.stringify(envelope(text), null, 2).split("\n").map(line => `data: ${line}`).join("\n");
  expect(parseExaResponse(`event: message\n${json}\n\n`)).toEqual(expected);
  expect(parseExaResponse(`data: {"jsonrpc":"2.0","method":"notification"}\n\ndata: ${JSON.stringify(envelope(text))}\n\n`)).toEqual(expected);
});

test("no credentials selects public Exa with no auth, user identifiers or model analytics", async () => {
  const t = transport(`event: message\ndata: ${JSON.stringify(envelope(text))}\n\n`, "text/event-stream");
  const result = await searchWeb('site:example.com "docs"', 1, undefined, { ...t, env: {} });
  expect(result.provider).toBe("exa");
  expect(result.data.web).toHaveLength(1);
  expect(t.calls[0]!.url.href).toBe(EXA_MCP_URL);
  expect(t.calls[0]!.init.headers).toEqual({ Accept: "application/json, text/event-stream", "User-Agent": "pi-generalist-extensions", "Content-Type": "application/json" });
  expect(JSON.parse(t.calls[0]!.init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: 'site:example.com "docs"', numResults: 1 } } });
  expect(t.calls).toHaveLength(1);
});

test("keyless Exa errors, throttling and format drift are errors, not fake empty results", async () => {
  for (const payload of [
    { jsonrpc: "2.0", id: 1, error: { message: "PRIVATE quota detail" } },
    { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "PRIVATE rate limit" }] } },
    envelope("Changed result format"), { unrelated: true },
  ]) {
    const t = transport(JSON.stringify(payload), "application/json");
    try { await searchWeb("q", 5, undefined, { ...t, env: {} }); throw new Error("expected failure"); }
    catch (error) { expect(String(error)).toContain("Web search (exa)"); expect(String(error)).not.toContain("PRIVATE"); }
    expect(t.calls).toHaveLength(1);
  }
  expect(parseExaResponse(JSON.stringify(envelope("No results found.")))).toEqual([]);
  const t = transport("PRIVATE", "text/plain", 429);
  await expect(searchWeb("q", 5, undefined, { ...t, env: {} })).rejects.toThrow("HTTP 429");
  expect(t.calls).toHaveLength(1); // No silent reroute to DDG/paid services.
});

test("DuckDuckGo Lite parser decodes source URLs and labelled snippets only", () => {
  expect(parseDuckDuckGoResponse(html)).toEqual([
    { title: "Synthetic Docs & 🌳", url: "https://example.com/docs?a=1&b=2", description: 'A synthetic snippet "test" \'quoted\' spaced.' },
    { title: "Second", url: "https://example.com/second", description: "Another <snippet>." },
  ]);
  expect(parseDuckDuckGoResponse("<div class='no-results'>No results found</div>")).toEqual([]);
});

test("DuckDuckGo is keyless and uses the fixed Lite endpoint, never follows result redirects", async () => {
  const t = transport(html, "text/html");
  const result = await searchWeb("a&b", 5, undefined, { ...t, env: { GENERALIST_WEB_SEARCH_PROVIDER: "ddg", TAVILY_API_KEY: "must-not-send" } });
  expect(result.provider).toBe("duckduckgo");
  expect(result.data.web).toHaveLength(2);
  expect(t.calls[0]!.url.origin + t.calls[0]!.url.pathname).toBe(DUCKDUCKGO_URL);
  expect(t.calls[0]!.url.searchParams.get("q")).toBe("a&b");
  expect(t.calls[0]!.init.method).toBe("GET");
  expect(t.calls[0]!.init.headers).not.toHaveProperty("Authorization");
  expect(t.calls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("rut=hash");
  expect(JSON.stringify(t.calls)).not.toContain("must-not-send");
});

test("DDG challenges and HTML drift fail explicitly; unsafe result URLs remain filtered", async () => {
  for (const body of ["<form id='challenge-form'>captcha</form>", "<div class='anomaly-modal'>blocked</div>", "<html>Unrecognized markup</html>"]) {
    const t = transport(body, "text/html", body.includes("captcha") ? 202 : 200);
    await expect(searchWeb("q", 5, undefined, { ...t, env: { GENERALIST_WEB_SEARCH_PROVIDER: "duckduckgo" } })).rejects.toThrow("Web search (duckduckgo)");
    expect(t.calls).toHaveLength(1);
  }
  const unsafe = `<a class='result-link' href='javascript:alert(1)'>bad</a><td class='result-snippet'>bad</td>
    <a class='result-link' href='https://user:pass@example.com'>secret</a>`;
  const result = await searchWeb("q", 5, undefined, { ...transport(unsafe, "text/html"), env: { GENERALIST_WEB_SEARCH_PROVIDER: "ddg" } });
  expect(result.data.web).toEqual([]);
});
