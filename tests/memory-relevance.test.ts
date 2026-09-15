import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/memory/store.ts";
import { RecallIndex, rebuildRecallIndex } from "../lib/memory/index.ts";
import { followupTerms, queryTerms } from "../lib/memory/query.ts";
import { makePacket, packetText } from "../lib/memory/select.ts";
import { encodeTransfer, MAX_REVISIONS, type Scope, type Snapshot } from "../lib/memory/schema.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-relevance-")); roots.push(root);
  const store = new MemoryStore(root), storeId = store.initialize();
  const project: Scope = `project:${randomUUID()}`, personal: Scope = `personal:${randomUUID()}`, other: Scope = `project:${randomUUID()}`;
  const add = (title: string, body: string, scope: Scope = project) => store.note({ scope, title, body,
    kind: "fact", author: "user", status: "accepted", sources: [] }, randomUUID()).id;
  const open = () => { rebuildRecallIndex(root, storeId); return new RecallIndex(root, storeId); };
  return { root, store, storeId, project, personal, other, add, open };
}

test("bounded query terms handle contractions and keep late topics, without executable FTS syntax", () => {
  expect(queryTerms("I'm sure it isn't working; aren't those results bad? I can't and won't", true)).toEqual(["results", "bad"]);
  expect(queryTerms("CAFÉ cafe\u0301 node.js bg_tasks C++ 中文")).toEqual(["cafe", "node", "js", "bg", "tasks", "c", "中文"]);
  expect(queryTerms('"OR" NEAR(foo) \'bar\'')).toEqual(["near", "foo", "bar"]);
  const verbose = "Can you look into improving the memory results? I'm thinking along a couple lines - better search, showing less memories when the matches are bad, considering cheap vectors. Also how are we writing new memories with this? Is it a tool that the model has to remember to call in the first place to add memories?";
  expect(queryTerms(verbose, true)).toContain("vectors");
  expect(queryTerms(verbose, true)).toContain("writing");
  const long = `${Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ")} embeddings`;
  expect(queryTerms(long, true)).toHaveLength(32); expect(queryTerms(long, true).at(-1)).toBe("embeddings");
  expect(queryTerms(`${" ".repeat(4096)}secret`, true)).toEqual([]);
  expect(queryTerms("a".repeat(65))).toEqual([]);
});

test("synthetic conversational benchmark: exact names, lexical paraphrases, follow-ups and expected-empty prompts", () => {
  const f = fixture();
  const memory = f.add("Native memory retrieval", "Native memory uses lexical search. Recalled packets keep fixed conversation boundaries. Weak matches are omitted.");
  const soul = f.add("Personality installation", "Meitan personality reads SOUL.md and COMPANION_CONTEXT.md. Copy these files to another computer.");
  const glyph = f.add("Glyph atlas eviction", "Glyph atlas eviction preserves cached font pages.");
  f.add("Vegetable soup", "Recipe ingredients include carrots and potatoes.");
  for (let i = 0; i < 18; i++) f.add(`Robotics milestone ${i}`, "New results after every turn. Rendering cache updated. Local simulator run removed old tests.");
  const cases = [
    { query: "Can you describe how native memory search works?", expected: [memory] },
    { query: "Does Meitan need SOUL.md on another computer?", expected: [soul] },
    { query: "How do recalled packets keep conversation boundaries?", expected: [memory] },
    { query: "Could we discuss glyph atlas eviction?", expected: [glyph] },
    { query: "Do those packets remain?", previousPrompt: "How does native memory search work?", expected: [memory] },
    { query: "Do those packets remain?", expected: [] },
    { query: "Are those actual results any good after a new turn?", expected: [] },
    { query: "Are those actual results any good after a new turn?", previousPrompt: "local simulator rendering cache", expected: [] },
    { query: "What is quasar flux spectroscopy?", expected: [] },
    { query: "Can you explain quasar cache radiation?", expected: [] },
    { query: "Please go ahead", previousPrompt: "How does native memory search work?", expected: [] },
    { query: "What about that quasar radiation instead?", previousPrompt: "How does native memory search work?", expected: [] },
  ];
  const index = f.open();
  try {
    let returned = 0, useful = 0, bytes = 0;
    for (const c of cases) {
      const result = index.search(c.query, [f.project], { automatic: true, previousPrompt: c.previousPrompt });
      const ids = result.items.map(i => i.id);
      expect({ query: c.query, ids }).toEqual({ query: c.query, ids: c.expected });
      returned += ids.length; useful += ids.filter(id => c.expected.includes(id)).length;
      if (ids.length) bytes += Buffer.byteLength(packetText(makePacket(index.generation, result.items)));
    }
    expect(useful).toBe(5); expect(returned).toBe(useful);
    // Metric is packet JSON including provenance, not body bytes or a token estimate.
    expect(bytes).toBeLessThan(12 * 1024);
    console.info(`Synthetic recall benchmark: ${cases.length} queries, ${useful}/${returned} useful hits, ${bytes} new packet bytes (excluding empty-selection transition framing)`);
  } finally { index.close(); }
});

test("rarity outranks common-word overlap; repeated text and substring collisions do not boost", () => {
  const f = fixture();
  const rare = f.add("Glyph atlas eviction", "Glyph atlas eviction preserves font pages.");
  for (let i = 0; i < 20; i++) f.add(`Fixture ${i}`, `${"rendering cache ".repeat(40)} partial artifice cartography`);
  const exact = f.add("Art cache", "Art cache contains reference images.");
  const index = f.open();
  try {
    expect(index.search("rendering cache glyph atlas eviction", [f.project], { automatic: true }).items[0].id).toBe(rare);
    expect(index.search("art cache", [f.project], { automatic: true }).items.map(i => i.id)).toEqual([exact]);
    expect(index.search("art cache", [f.project]).items.map(i => i.id)).toEqual([exact]);
  } finally { index.close(); }
});

test("automatic default is at most three lexical hits; manual remains ten; pins are additional and scope-bound", () => {
  const f = fixture(); for (let i = 0; i < 12; i++) f.add(`Cache ${i}`, "Cache rendering preference");
  const pin = f.add("Pinned preference", "Use concise answers"), hidden = f.add("Hidden pin", "Other scope", f.other);
  const index = f.open();
  try {
    expect(index.search("cache", [f.project], { automatic: true }).items).toHaveLength(3);
    expect(index.search("cache", [f.project]).items).toHaveLength(10);
    const pinned = index.search("cache", [f.project], { automatic: true, pins: [pin, hidden] });
    expect(pinned.items).toHaveLength(4); expect(pinned.items.find(i => i.id === pin)?.reason).toBe("human pin");
    expect(index.search("go ahead", [f.project], { automatic: true, pins: [pin] }).items.map(i => i.id)).toEqual([pin]);
  } finally { index.close(); }
});

test("direct current-topic matches precede contextual support at the limit boundary", () => {
  const f = fixture();
  const direct = f.add("Durable packets", "Packets are durable.");
  const supported = f.add("Native memory search", "Native memory search retains packets.");
  const index = f.open();
  try {
    const query = "Do those packets remain durable?", previousPrompt = "native memory search";
    expect(index.search(query, [f.project], { automatic: true, previousPrompt }).items.map(i => i.id)).toEqual([direct, supported]);
    expect(index.search(query, [f.project], { automatic: true, previousPrompt, limit: 1 }).items.map(i => i.id)).toEqual([direct]);
    expect(index.search("results", [f.project], { automatic: true, previousPrompt }).items).toEqual([]);
  } finally { index.close(); }
});

test("rarity and gate use exact scopes; weak personal hits cannot reserve a slot; duplicate scopes are harmless", () => {
  const f = fixture();
  const one = f.add("Glyph atlas eviction", "Glyph atlas eviction policy");
  f.add("Glyph atlas drawing", "Glyph atlas drawing pipeline");
  f.add("Atlas eviction", "Atlas eviction handling");
  f.add("Unrelated personal", "Atlas is the name of a game", f.personal);
  let index = f.open();
  const query = "glyph atlas eviction";
  let before: string[];
  try {
    before = index.search(query, [f.project, f.personal], { automatic: true }).items.map(i => i.id);
    expect(before).toHaveLength(3); expect(before[0]).toBe(one);
    expect(index.search(query, [f.project, f.project, f.personal], { automatic: true }).items.map(i => i.id)).toEqual(before);
  } finally { index.close(); }
  for (let i = 0; i < 50; i++) f.add(`Unapproved ${i}`, "glyph atlas eviction", f.other);
  index = f.open();
  try { expect(index.search(query, [f.project, f.personal], { automatic: true }).items.map(i => i.id)).toEqual(before); }
  finally { index.close(); }
  const personal = f.add("Personal font preference", "Glyph atlas eviction preferences", f.personal);
  index = f.open();
  try { expect(index.search(query, [f.project, f.personal], { automatic: true }).items.map(i => i.id)).toContain(personal); }
  finally { index.close(); }
});

test("FTS supplies exact token evidence for accented/non-Latin words and punctuated names", () => {
  const f = fixture();
  const accent = f.add("Café", "Cafe\u0301 rendering preferences");
  const unicode = f.add("中文", "中文 rendering preferences");
  const korean = f.add("한국", "한국 설정");
  const devanagari = f.add("नमस्ते", "नमस्ते");
  const identifier = f.add("bg_tasks", "Finite background jobs");
  const index = f.open();
  try {
    expect(index.search("cafe", [f.project]).items.map(i => i.id)).toEqual([accent]);
    expect(index.search("CAFÉ", [f.project]).items.map(i => i.id)).toEqual([accent]);
    expect(index.search("中文", [f.project]).items.map(i => i.id)).toEqual([unicode]);
    expect(index.search("한국", [f.project]).items.map(i => i.id)).toEqual([korean]);
    expect(index.search("नमस्ते", [f.project]).items.map(i => i.id)).toEqual([devanagari]);
    expect(index.search("bg_tasks", [f.project], { automatic: true }).items.map(i => i.id)).toEqual([identifier]);
  } finally { index.close(); }
});

test("topic signals are bounded, elliptical-only, and never replace a current query", () => {
  const previousPrompt = "native memory search lexical recall packets boundaries";
  expect(followupTerms("Do those packets remain?", previousPrompt)).toEqual(["native", "memory", "search", "lexical", "recall", "boundaries"]);
  expect(followupTerms("Explain recipe ingredients", previousPrompt)).toEqual([]);
  expect(followupTerms("Instead, what about those recipe ingredients?", previousPrompt)).toEqual([]);
  expect(followupTerms("Go ahead", previousPrompt)).toEqual([]);
  expect(followupTerms("Are those results bad?", previousPrompt)).toEqual([]);
  expect(followupTerms("Does it handle one two three four five six seven eight nine?", previousPrompt)).toEqual([]);
  expect(followupTerms("Does it persist?", " ".repeat(1024) + "hidden")).toEqual([]);
});

test("maximum-corpus tied postings remain bounded and use date/ID cutoff; report lookup latency", () => {
  const f = fixture(), query = Array.from({ length: 32 }, (_, i) => `term${i}`).join(" ");
  const snapshot: Snapshot = { format: "pi-memory-prototype", version: 4, storeId: f.storeId,
    revisions: Array.from({ length: MAX_REVISIONS }, (_, i) => ({
      id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, revision: 1, operation: randomUUID(),
      createdAt: i >= MAX_REVISIONS - 2 ? "2026-01-01T00:00:00.000Z" : "2025-01-01T00:00:00.000Z",
      scope: f.project, kind: "fact", author: "user", status: "accepted", title: "Synthetic maximum corpus",
      body: query, sources: [], reason: "Synthetic fixture import",
    })) };
  // One validated fixture import avoids thousands of quadratic store writes.
  f.store.import(Buffer.from(encodeTransfer(snapshot)), false);
  const index = f.open();
  try {
    const result = index.search(query, [f.project], { automatic: true });
    expect(result.items.map(i => i.id)).toEqual([
      snapshot.revisions[MAX_REVISIONS - 2].id, snapshot.revisions[MAX_REVISIONS - 1].id, snapshot.revisions[0].id,
    ]);
    expect(result.milliseconds).toBeGreaterThanOrEqual(0);
    console.info(`Synthetic maximum recall: ${MAX_REVISIONS} records x 32 terms, ${result.milliseconds} ms lookup, ${result.items.length} returned`);
  } finally { index.close(); }
}, 30000);
