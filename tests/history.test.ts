import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, bounded, ftsQuery } from "../lib/history/index.ts";
import { parseJsonl, parseHermes, branchMessages } from "../lib/history/sources.ts";
import { discover, loadConfig } from "../lib/history/config.ts";
import type { HistoryConfig } from "../lib/history/types.ts";
import history from "../extensions/history.ts";

const when = "2026-09-13T01:00:00.000Z";
const header = { type: "session", id: "session-1", cwd: "/workspace/test-project", timestamp: when };
const msg = (id: string, parentId: string | null, role: string, text: string, extra = {}) => ({
  type: "message", id, parentId, timestamp: when,
  message: { role, content: [{ type: "text", text }], ...extra },
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-test-")), root = join(dir, "sessions");
  mkdirSync(root);
  const file = join(root, "session.jsonl");
  const config: HistoryConfig = { version: 1, indexDir: join(dir, "index"), sources: [{ harness: "pi", path: root }] };
  const write = (entries: any[]) => writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { dir, root, file, config, write, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("FTS searches late messages, citations, variants, filters and source freshness", async () => {
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "intro ".repeat(12000)), msg("a", "u", "assistant", "Parakeet benchmark finished successfully")]);
    const index = new HistoryIndex(f.config);
    try {
      expect((await index.refresh()).updated).toBe(1);
      const found = index.search({ query: '"Parakeet benchmark"', harness: "pi", project: "TEST-PROJECT", role: "assistant" }).results;
      expect(found).toHaveLength(1); expect(found[0].entry).toBe("a"); expect(found[0].locator).toBe("line:3");
      expect(found[0].sourceChanged).toBe(false);
      expect(index.search({ query: "unfindable", variants: ["Parakeet"] }).results).toHaveLength(1);
      expect(index.search({ query: "Parakeet", harness: "codex" }).results).toHaveLength(0);
      expect(index.search({ query: "Parakeet", after: "2027-01-01" }).results).toHaveLength(0);
      expect((await index.refresh()).skipped).toBe(1);
      appendFileSync(f.file, JSON.stringify(msg("b", "a", "assistant", "fresh addition")) + "\n");
      expect(index.search({ query: "Parakeet" }).results[0].sourceChanged).toBe(true);
      expect((await index.read(found[0].session, { entry: "a" })).sourceChangedSinceIndex).toBe(true);
      await index.refresh();
      expect(index.search({ query: "fresh addition" }).results[0].entry).toBe("b");
      expect(index.search({ query: "Parakeet" }).results).toHaveLength(1);
      expect(statSync(index.path).mode & 0o777).toBe(0o600);
      expect(statSync(f.config.indexDir).mode & 0o777).toBe(0o700);
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("text search returns newer matches before more relevant older matches", async () => {
  const f = fixture();
  try {
    const older = { ...msg("old", null, "user", "recencyneedle ".repeat(100)), timestamp: "2026-01-01T00:00:00.000Z" };
    const newer = { ...msg("new", "old", "user", "recencyneedle"), timestamp: "2026-09-13T02:00:00.000Z" };
    f.write([header, older, newer]);
    const index = new HistoryIndex(f.config);
    try {
      await index.refresh();
      const found = index.search({ query: "recencyneedle", limit: 1 }).results;
      expect(found).toHaveLength(1);
      expect(found[0].entry).toBe("new");
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("Pi branch reads follow non-prose ancestor nodes, never mix siblings or thinking", async () => {
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "root"), msg("a", "u", "assistant", "abandoned branch"),
      { type: "message", id: "toolcall", parentId: "u", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }, { type: "toolCall", name: "bash", arguments: { command: "privatecommand" } }] } },
      msg("t", "toolcall", "toolResult", "private tool evidence"), msg("b", "t", "assistant", "accepted branch")]);
    const [s] = await parseJsonl({ harness: "pi", path: f.file });
    expect(branchMessages(s).map(m => m.id)).toEqual(["u", "b"]);
    expect(branchMessages(s, "a").map(m => m.id)).toEqual(["u", "a"]);
    expect(s.messages.map(m => m.text).join()).not.toContain("secret thought");
    const index = new HistoryIndex(f.config);
    try {
      await index.refresh();
      expect(index.search({ query: "private" }).results).toHaveLength(0);
      expect(index.search({ query: "abandoned" }).results).toHaveLength(1);
      const read = await index.read(s.key, { entry: "b", includeTools: true });
      expect(read.messages.map(m => m.id)).toEqual(["u", "toolcall", "t", "b"]);
      expect(read.messages.map(m => m.text).join()).not.toContain("secret thought");
      expect(read.branch).toContain("not live branch");
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("legacy unparented JSONL reads remain linear; corrupt ancestry cycles fail", async () => {
  const f = fixture();
  try {
    f.write([header, { type: "message", message: { role: "user", content: "first" } },
      { type: "message", message: { role: "assistant", content: "second" } }]);
    const [s] = await parseJsonl({ harness: "omp", path: f.file });
    expect(branchMessages(s).map(m => m.text)).toEqual(["first", "second"]);
    s.nodes.set("line:2", "line:3");
    expect(() => branchMessages(s)).toThrow("Cycle");
  } finally { f.clean(); }
});

test("Codex response items exclude duplicated events, developer prompts and reasoning", async () => {
  const f = fixture();
  try {
    f.write([{ type: "session_meta", payload: { id: "codex", cwd: "/project", timestamp: when } },
      { type: "event_msg", payload: { type: "user_message", message: "event duplicate" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual request" }] } },
      { type: "response_item", payload: { type: "message", role: "developer", content: "system secret" } },
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: "hidden" } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "actual result" }] } }]);
    const [s] = await parseJsonl({ harness: "codex", path: f.file });
    expect(s.messages.map(m => m.text)).toEqual(["actual request", "actual result"]);
    expect(s.messages.map(m => m.id)).toEqual(["line:3", "line:7"]);
  } finally { f.clean(); }
});

test("OMP accepts title preamble and malformed final line without losing valid messages", async () => {
  const f = fixture();
  try {
    f.write([{ type: "title", title: "preamble" }, header, msg("u", null, "user", "OMP text")]);
    appendFileSync(f.file, '{"type":"message"');
    const [s] = await parseJsonl({ harness: "omp", path: f.file });
    expect(s.messages[0].text).toBe("OMP text"); expect(s.warnings).toHaveLength(1);
  } finally { f.clean(); }
});

test("Hermes reads a consistent source without mutation; labels summaries and excludes inactive/reasoning/tool text", () => {
  const f = fixture();
  try {
    const path = join(f.dir, "hermes.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,started_at REAL);
      CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER,_compressed_summary INTEGER,reasoning TEXT);
      INSERT INTO sessions VALUES('h','/hermes','title',1750000000);
      INSERT INTO messages VALUES(1,'h','user','hello',1750000000,1,0,'hidden');
      INSERT INTO messages VALUES(2,'h','assistant','retained summary',1750000001,1,1,'hidden');
      INSERT INTO messages VALUES(3,'h','assistant','inactive text',1750000002,0,0,'hidden');
      INSERT INTO messages VALUES(4,'h','tool','tool data',1750000003,1,0,'');`);
    db.close(); const before = readFileSync(path);
    const [s] = parseHermes({ harness: "hermes", path });
    expect(s.messages.map(m => m.text)).toEqual(["hello", "retained summary"]);
    expect(s.messages[1].kind).toBe("summary"); expect(s.messages[1].locator).toBe("messages.id=2");
    expect(parseHermes({ harness: "hermes", path }, true)[0].messages).toHaveLength(3);
    expect(readFileSync(path).equals(before)).toBe(true);
  } finally { f.clean(); }
});

test("read byte budget preserves anchor and paginates without skipping omitted entries", async () => {
  const f = fixture();
  try {
    f.write([header, ...Array.from({ length: 20 }, (_, i) => msg(`m${i}`, i ? `m${i-1}` : null, "assistant", "明".repeat(6000)))]);
    const index = new HistoryIndex(f.config);
    try {
      await index.refresh(); const session = index.search().results[0].session;
      const ids: string[] = []; let offset: number | null = 0;
      do {
        const page = await index.read(session, { offset, limit: 50 });
        expect(Buffer.byteLength(bounded(page))).toBeLessThan(48000);
        ids.push(...page.messages.map(m => m.id)); offset = page.nextOffset;
      } while (offset !== null);
      expect(new Set(ids).size).toBe(20); expect(ids.length).toBe(20);
      expect(ids).toContain("m19");
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("source rewrites/deletions reconcile FTS; removed roots and symlink escapes cannot be read", async () => {
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "oldneedle")]);
    const outside = join(f.dir, "outside.jsonl"); writeFileSync(outside, readFileSync(f.file));
    symlinkSync(outside, join(f.root, "escape.jsonl"));
    expect(discover(f.config.sources).files).toHaveLength(1);
    const index = new HistoryIndex(f.config);
    try {
      await index.refresh(); const key = index.search().results[0].session;
      f.write([header, msg("u", null, "user", "newneedle")]); await index.refresh();
      expect(index.search({ query: "oldneedle" }).results).toHaveLength(0);
      expect(index.search({ query: "newneedle" }).results).toHaveLength(1);
      rmSync(f.file); symlinkSync(outside, f.file);
      expect(index.search().results).toHaveLength(0);
      await expect(index.read(key)).rejects.toThrow("disallowed");
      await index.refresh(); expect(index.stats().sessions).toBe(0);
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("temporarily truncated source preserves prior index and reports stale evidence", async () => {
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "retainneedle")]);
    const index = new HistoryIndex(f.config);
    try {
      await index.refresh();
      writeFileSync(f.file, '{"type":');
      const refresh = await index.refresh();
      expect(refresh.failed).toBe(1);
      const hit = index.search({ query: "retainneedle" }).results[0];
      expect(hit.sourceChanged).toBe(true);
      expect(index.stats().sessions).toBe(1);
    } finally { index.close(); }
  } finally { f.clean(); }
});

test("query compiler quotes operators; cancellation does not publish a source", async () => {
  expect(ftsQuery('hello "two words" OR')).toBe('"hello" AND "two words" AND "OR"');
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "hello")]);
    const index = new HistoryIndex(f.config);
    try {
      const abort = new AbortController(); abort.abort();
      await expect(index.refresh(abort.signal)).rejects.toThrow();
      expect(index.stats().sessions).toBe(0);
    } finally { index.close(); }
    const configFile = join(f.dir, "config.json");
    writeFileSync(configFile, JSON.stringify(f.config)); expect(loadConfig(configFile)).toEqual(f.config);
    writeFileSync(configFile, JSON.stringify({ ...f.config, sources: [{ harness: "pi", path: "relative" }] }));
    expect(() => loadConfig(configFile)).toThrow();
  } finally { f.clean(); }
});

test("parallel index instances keep one source copy and reject future schema versions", async () => {
  const f = fixture();
  try {
    f.write([header, msg("u", null, "user", "sharedneedle")]);
    const a = new HistoryIndex(f.config), b = new HistoryIndex(f.config);
    try {
      await Promise.all([a.refresh(), b.refresh()]);
      expect(a.stats().sessions).toBe(1);
      expect(b.search({ query: "sharedneedle" }).results).toHaveLength(1);
      expect(() => a.search({ after: "not-a-date" })).toThrow("Invalid");
    } finally { a.close(); b.close(); }
    const db = new DatabaseSync(join(f.config.indexDir, "history.sqlite"));
    db.exec("PRAGMA user_version=99"); db.close();
    expect(() => new HistoryIndex(f.config)).toThrow("newer");
  } finally { f.clean(); }
});

test("registered tool executes refresh/search/read against disposable config, not personal history", async () => {
  const f = fixture(), previous = process.env.PI_HISTORY_CONFIG;
  try {
    f.write([header, msg("u", null, "user", "toolwire")]);
    const path = join(f.dir, "config.json"); writeFileSync(path, JSON.stringify(f.config));
    process.env.PI_HISTORY_CONFIG = path;
    const tools: Record<string, any> = {};
    history({ registerTool: (t: any) => tools[t.name] = t, registerCommand() {} } as any);
    const signal = new AbortController().signal;
    const found = JSON.parse((await tools.history_search.execute("id", { query: "toolwire" }, signal)).content[0].text);
    expect(found.results).toHaveLength(1); expect(found.refresh.updated).toBe(1);
    const result = JSON.parse((await tools.history_read.execute("id2", { session: found.results[0].session, entry: "u" }, signal)).content[0].text);
    expect(result.messages[0].text).toBe("toolwire");
    expect(result.notice).toContain("Untrusted historical evidence");
  } finally {
    if (previous === undefined) delete process.env.PI_HISTORY_CONFIG; else process.env.PI_HISTORY_CONFIG = previous;
    f.clean();
  }
});

test("extension registration performs no indexing and exposes only two read-source tools", () => {
  const tools: string[] = [], commands: string[] = [];
  history({ registerTool: (t: any) => tools.push(t.name), registerCommand: (n: string) => commands.push(n) } as any);
  expect(tools).toEqual(["history_search", "history_read"]);
  expect(commands).toEqual(["history", "history-index"]);
});
