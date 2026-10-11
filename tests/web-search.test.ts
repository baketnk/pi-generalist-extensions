import { expect, test } from "bun:test";
import { resolveSearchProvider, searchWeb } from "../lib/web-search.ts";
import webSearch from "../extensions/web-search.ts";
import { generalistDefaults, registerGeneralistSettings } from "../extensions/generalist-settings.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

const hit = { title: "Example", url: "https://example.com/", description: "Snippet" };
function transport(payload: unknown, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(payload, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

test("Hermes-style credential selection and explicit provider stay deterministic", async () => {
  expect(resolveSearchProvider({ TAVILY_API_KEY: "t", BRAVE_SEARCH_API_KEY: "b" })).toBe("tavily");
  expect(resolveSearchProvider({ FIRECRAWL_API_URL: "http://localhost:3002", SEARXNG_URL: "http://localhost" })).toBe("firecrawl");
  expect(resolveSearchProvider({ SEARXNG_URL: "http://localhost", BRAVE_SEARCH_API_KEY: "b" })).toBe("searxng");
  expect(resolveSearchProvider({ GENERALIST_WEB_SEARCH_PROVIDER: "BRAVE-FREE", TAVILY_API_KEY: "t" })).toBe("brave");
  expect(() => resolveSearchProvider({ GENERALIST_WEB_SEARCH_PROVIDER: "wrong" })).toThrow("Unknown");
  expect(resolveSearchProvider({})).toBe("exa");
  expect(resolveSearchProvider({ GENERALIST_WEB_SEARCH_PROVIDER: "ddg" })).toBe("duckduckgo");
  const t = transport({ results: [] });
  await expect(searchWeb("query", 5, undefined, { ...t, env: { GENERALIST_WEB_SEARCH_PROVIDER: "brave", TAVILY_API_KEY: "t" } })).rejects.toThrow("BRAVE_SEARCH_API_KEY");
  expect(t.calls).toHaveLength(0);
});

test("Tavily sends operators verbatim, default 5, no raw content, and caps at 20", async () => {
  const t = transport({ results: [{ ...hit, description: undefined, content: "Content" }] });
  const env = { TAVILY_API_KEY: "test-key" };
  const result = await searchWeb('site:example.com "a b" -c', undefined, undefined, { ...t, env });
  expect(t.calls[0]!.url.href).toBe("https://api.tavily.com/search");
  expect(t.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer test-key" });
  expect(JSON.parse(t.calls[0]!.init.body as string)).toEqual({ query: 'site:example.com "a b" -c', max_results: 5, include_raw_content: false, include_images: false });
  expect(result.data.web).toEqual([{ ...hit, description: "Content", position: 1 }]);
  expect(JSON.stringify(result)).not.toContain("test-key");
  await searchWeb("query", 100, undefined, { ...t, env });
  expect(JSON.parse(t.calls[1]!.init.body as string).max_results).toBe(20);
});

test("Brave and SearXNG use GET and normalize/sort results", async () => {
  const b = transport({ web: { results: [hit] } });
  await searchWeb("a&b", 100, undefined, { ...b, env: { BRAVE_SEARCH_API_KEY: "key" } });
  expect(b.calls[0]!.url.searchParams.get("q")).toBe("a&b");
  expect(b.calls[0]!.url.searchParams.get("count")).toBe("20");
  expect(b.calls[0]!.init.headers).toMatchObject({ "X-Subscription-Token": "key" });
  expect(b.calls[0]!.init.method).toBe("GET");
  const s = transport({ results: [{ ...hit, score: 1, content: "low" }, { ...hit, title: "Top", description: undefined, score: 10, content: "high" }] });
  const result = await searchWeb("q", 1, undefined, { ...s, env: { SEARXNG_URL: "http://localhost:8080/prefix/" } });
  expect(s.calls[0]!.url.href).toBe("http://localhost:8080/prefix/search?q=q&format=json&pageno=1");
  expect(result.data.web).toEqual([{ ...hit, title: "Top", description: "high", position: 1 }]);
});

test("Firecrawl accepts current and legacy result envelopes, self-hosting needs no key", async () => {
  for (const payload of [{ data: { web: [hit] } }, { data: [hit] }, { web: [hit] }, { results: [hit] }]) {
    const t = transport({ success: true, ...payload });
    const result = await searchWeb("q", 5, undefined, { ...t, env: { FIRECRAWL_API_URL: "http://localhost:3002/" } });
    expect(t.calls[0]!.url.href).toBe("http://localhost:3002/v2/search");
    expect(t.calls[0]!.init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(t.calls[0]!.init.body as string)).toEqual({ query: "q", limit: 5, sources: ["web"] });
    expect(result.data.web).toEqual([{ ...hit, position: 1 }]);
  }
});

test("input validation and endpoint errors make no network calls", async () => {
  const t = transport({ results: [] });
  const env = { TAVILY_API_KEY: "key" };
  for (const q of ["", "  ", "x".repeat(2001)]) await expect(searchWeb(q, 5, undefined, { ...t, env })).rejects.toThrow("query");
  for (const n of [0, 101, 2.5, NaN]) await expect(searchWeb("q", n, undefined, { ...t, env })).rejects.toThrow("limit");
  for (const url of ["bad", "file:///tmp", "https://user:secret@example.com", "https://example.com?key=secret"]) {
    await expect(searchWeb("q", 5, undefined, { ...t, env: { ...env, TAVILY_BASE_URL: url } })).rejects.toThrow("endpoint");
  }
  expect(t.calls).toHaveLength(0);
});

test("HTTP, provider and malformed errors never echo vendor bodies or fall back", async () => {
  const env = { TAVILY_API_KEY: "SECRET", BRAVE_SEARCH_API_KEY: "also-secret" };
  const t = transport({ error: "SECRET" }, 429);
  await expect(searchWeb("q", 5, undefined, { ...t, env })).rejects.toThrow("HTTP 429");
  expect(t.calls).toHaveLength(1);
  for (const payload of [{ success: false, error: "SECRET" }, {}, null]) {
    try { await searchWeb("q", 5, undefined, { ...transport(payload), env }); throw new Error("expected failure"); }
    catch (error) { expect(String(error)).not.toContain("SECRET"); expect(String(error)).toContain("Web search"); }
  }
  const fetch = (async () => new Response("not JSON")) as unknown as typeof globalThis.fetch;
  await expect(searchWeb("q", 5, undefined, { fetch, env })).rejects.toThrow("invalid JSON");
  const failing = (async () => { throw new Error("Web search transport contains SECRET"); }) as unknown as typeof globalThis.fetch;
  await expect(searchWeb("q", 5, undefined, { fetch: failing, env })).rejects.toThrow("request failed");
});

test("cancellation and deadline reach the fetch signal", async () => {
  const env = { TAVILY_API_KEY: "key" };
  const t = transport({ results: [] });
  await expect(searchWeb("q", 5, AbortSignal.abort(), { ...t, env })).rejects.toThrow();
  expect(t.calls).toHaveLength(0);
  const waiting = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof globalThis.fetch;
  const controller = new AbortController();
  const promise = searchWeb("q", 5, controller.signal, { fetch: waiting, env });
  controller.abort();
  await expect(promise).rejects.toThrow("cancelled");
  // Keep Bun's loop alive while AbortSignal.timeout's unref'ed timer runs.
  const keepAlive = setInterval(() => {}, 100);
  try { await expect(searchWeb("q", 5, undefined, { fetch: waiting, env, timeoutMs: 5 })).rejects.toThrow("timed out"); }
  finally { clearInterval(keepAlive); }
});

test("response bytes and returned data are bounded and terminal controls removed", async () => {
  const env = { TAVILY_API_KEY: "key" };
  const tooBig = transport({ results: [], padding: "x".repeat(2 * 1024 * 1024) });
  await expect(searchWeb("q", 5, undefined, { ...tooBig, env })).rejects.toThrow("exceeds 2 MiB");
  const rows = Array.from({ length: 100 }, () => ({ ...hit, title: "\x1b[31m" + "a".repeat(500), content: "文".repeat(2000), description: undefined }));
  rows.unshift({ ...hit, url: "javascript:alert(1)", content: "bad", description: undefined });
  const result = await searchWeb("q", 100, undefined, { ...transport({ results: rows }), env });
  expect(result.truncated).toBe(true);
  expect(result.data.web.length).toBeGreaterThan(0);
  expect(result.data.web.length).toBeLessThan(100);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(34 * 1024);
  expect(JSON.stringify(result)).not.toContain("javascript:");
  expect(JSON.stringify(result)).not.toContain("\\u001b");
  expect(result.data.web[0]!.position).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(result.data.web))).toBeLessThanOrEqual(32 * 1024);
  const unsafeUrls = await searchWeb("q", 5, undefined, { ...transport({ results: [
    { ...hit, url: "https://example.com/" + "x".repeat(2048) },
    { ...hit, url: "https://example.com/\u001bhidden" },
    { ...hit, url: "https://user:secret@example.com" },
  ] }), env });
  expect(unsafeUrls.data.web).toEqual([]);
  expect(unsafeUrls.truncated).toBe(true);
});

function harness(defaultValue?: boolean, entries: any[] = []) {
  const events: Record<string, Function[]> = {}, commands: Record<string, any> = {}, tools: Record<string, any> = {};
  let active = ["read", "bash", "web_search", "other"];
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn),
    registerFlag() {}, getFlag: () => false,
    registerCommand: (name: string, def: any) => commands[name] = def,
    registerTool: (def: any) => tools[def.name] = def,
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getActiveTools: () => active, setActiveTools: (names: string[]) => active = names,
  };
  const ctx: any = { hasUI: false, mode: "print", waitForIdle: async () => {}, sessionManager: { getBranch: () => entries } };
  const enabled = webSearch(pi, undefined, () => defaultValue);
  const off = Object.assign(() => false, { set() {} });
  const features = { meitan: off, memory: off, websearch: enabled };
  registerGeneralistSettings(pi, features);
  const emit = async (name: string) => { for (const fn of events[name] ?? []) await fn({}, ctx); };
  return { active: () => active, emit, ctx, enabled, entries, commands, tools, features, events };
}

test("Generalist websearch is off by default, independently toggled, saved and branch-restored", async () => {
  const h = harness(); await h.emit("session_start");
  expect(h.active()).toEqual(["read", "bash", "other"]);
  await expect(h.tools.web_search.execute("id", { query: "q" }, undefined, undefined, h.ctx)).rejects.toThrow("disabled");
  await h.commands.generalist.handler("websearch on", h.ctx);
  expect(h.enabled()).toBe(true); expect(h.active()).toContain("web_search");
  expect(generalistDefaults(h.features, h.ctx).websearch).toBe(true);
  await h.commands.generalist.handler("websearch toggle", h.ctx);
  expect(h.enabled()).toBe(false);
  h.entries.pop(); await h.emit("session_tree"); expect(h.enabled()).toBe(true);
  const reloaded = harness(false, h.entries); await reloaded.emit("session_start"); expect(reloaded.enabled()).toBe(true);
  const fresh = harness(true); await fresh.emit("session_start"); expect(fresh.enabled()).toBe(true);
  expect(h.commands.generalist.getArgumentCompletions("web")).toEqual([{ value: "websearch", label: "websearch" }]);
  expect(Object.keys(h.events).sort()).toEqual(["session_start", "session_tree"]); // No context or per-turn reinjection.
});

test("Web search appears as a toggle in Generalist TUI", async () => {
  const h = harness(); await h.emit("session_start");
  h.ctx.hasUI = true; h.ctx.mode = "tui";
  initTheme("dark", false);
  h.ctx.ui = { custom: async (factory: any) => {
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    const component = factory({ requestRender() {} }, theme, {}, () => {});
    expect(component.render(100).join("\n")).toContain("Web search");
  } };
  await h.commands.generalist.handler("", h.ctx);
});
