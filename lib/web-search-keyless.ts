// Public keyless adapters: Exa follows Hermes plugins/web/keyless_mcp.py;
// DuckDuckGo uses the public Lite search page instead of a Python DDGS subprocess.
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const DUCKDUCKGO_URL = "https://lite.duckduckgo.com/lite/";
export type KeylessHit = { title: string; url: string; description: string };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Exa accepts stateless tools/call and returns JSON or SSE JSON-RPC envelopes. */
export function parseExaResponse(body: string): KeylessHit[] {
  const candidates = body.trimStart().startsWith("{") ? [body] : body.replace(/\r\n/g, "\n").split(/\n\n/)
    .map(event => event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"));
  for (const candidate of candidates) {
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(candidate)); } catch { continue; }
    if (payload.id !== 1) continue; // Ignore notifications and unrelated SSE frames.
    const result = record(payload.result);
    if (payload.error || result.isError) throw new Error("Web search (exa) failed: keyless MCP error or rate limit.");
    const content = result.content;
    if (!Array.isArray(content)) continue;
    const text = content.map(record).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text as string).join("\n");
    if (!text.trim()) continue;
    const rows: KeylessHit[] = [];
    for (const block of text.split(/\n\s*---\s*\n/)) {
      let title = "", url = "", highlights = false;
      const description: string[] = [];
      for (const line of block.split(/\r?\n/).map(line => line.trim())) {
        const field = /^(Title|URL|Highlights|Published|Author):\s*(.*)$/.exec(line);
        if (field) {
          highlights = field[1] === "Highlights";
          if (field[1] === "Title") title = field[2]!;
          if (field[1] === "URL") url = field[2]!;
          if (highlights && field[2]) description.push(field[2]);
        } else if (highlights && line) description.push(line);
      }
      if (url) rows.push({ title, url, description: description.join(" ") });
    }
    if (rows.length) return rows;
    if (/^\s*(?:No (?:search )?results(?: found)?)[.!\s]*$/i.test(text)) return [];
    throw new Error("Web search (exa) returned an unrecognized search format.");
  }
  throw new Error("Web search (exa) returned an invalid MCP response.");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return named[name.toLowerCase()] ?? entity;
  });
}
const plainText = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
function attribute(attrs: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/** Target the Lite page's labelled result anchors/snippet cells, not arbitrary page links. */
export function parseDuckDuckGoResponse(html: string): KeylessHit[] {
  if (/anomaly-modal|challenge-form|anomaly\.js/i.test(html)) throw new Error("Web search (duckduckgo) was blocked by a bot challenge.");
  const rows: KeylessHit[] = [];
  const tokens = /<(a|td)\b([^>]*\bclass\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let current: KeylessHit | undefined;
  for (const match of html.matchAll(tokens)) {
    const classes = attribute(match[2]!, "class").split(/\s+/);
    if (match[1]!.toLowerCase() === "a" && classes.includes("result-link")) {
      const href = attribute(match[2]!, "href");
      let url: URL;
      try { url = new URL(href, DUCKDUCKGO_URL); } catch { current = undefined; continue; }
      const isDdg = url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com");
      const target = isDdg ? url.searchParams.get("uddg") : null;
      current = { title: plainText(match[3]!), url: target ?? url.href, description: "" };
      rows.push(current);
    } else if (classes.includes("result-snippet") && current) {
      current.description = plainText(match[3]!);
    }
  }
  if (rows.length) return rows;
  if (/No results found|class\s*=\s*["'][^"']*\bno-results\b/i.test(html)) return [];
  throw new Error("Web search (duckduckgo) returned an unrecognized search page.");
}
