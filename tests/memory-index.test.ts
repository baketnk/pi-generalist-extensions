import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/memory/store.ts";
import { RecallIndex, rebuildRecallIndex, queryTerms } from "../lib/memory/index.ts";
import { INDEX_FILE, INDEX_TEMP } from "../lib/memory/derived.ts";
import { makePacket, packetText } from "../lib/memory/select.ts";
import { decodeTransfer, type Note, type Scope } from "../lib/memory/schema.ts";

const roots: string[] = [], project: Scope = `project:${randomUUID()}`, personal: Scope = `personal:${randomUUID()}`, other: Scope = `project:${randomUUID()}`;
function fixture() { const root = mkdtempSync(join(tmpdir(), "memory-index-test-")); roots.push(root); const store = new MemoryStore(root); const storeId = store.initialize(); return { root, store, storeId }; }
function note(scope = project, body = "Fixture rendering font cache decision", status: Note["status"] = "accepted"): Note { return { scope, body, title: "Fixture decision", kind: "fact", status, author: "assistant", sources: [] }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("explicit rebuild creates scoped FTS; candidates, artifacts, old revisions and unrelated projects never recall", () => {
  const f = fixture(), row = f.store.note(note(), randomUUID());
  f.store.note(note(personal), randomUUID()); f.store.note(note(other), randomUUID()); f.store.note(note(project, "Candidate rendering", "candidate"), randomUUID());
  f.store.revise(row.id, 1, note(project, "Corrected rendering choice"), "Correction", randomUUID());
  expect(existsSync(join(f.root, INDEX_FILE))).toBe(false);
  const built = rebuildRecallIndex(f.root, f.storeId); expect(built.records).toBe(3);
  const index = new RecallIndex(f.root, f.storeId);
  try {
    const result = index.search("rendering", [project]); expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: row.id, revision: 2, body: "Corrected rendering choice" });
    expect(index.search("font", [project]).items).toHaveLength(0);
    expect(index.search("rendering", []).items).toHaveLength(0);
    expect(() => index.search("rendering", ["unassigned"])).toThrow();
    expect(index.search("rendering", [personal]).items).toHaveLength(1);
    expect(index.search("rendering OR font", [project]).items).toHaveLength(0); // literal tokens, not FTS syntax
    expect(index.search("How should we change rendering?", [project], { automatic: true }).items).toHaveLength(1);
    expect(index.search("the and or", [project]).items).toHaveLength(0);
  } finally { index.close(); }
});

test("every canonical write deletes cache; an already-open reader rejects the stale generation", () => {
  const f = fixture(); f.store.note(note(), randomUUID()); rebuildRecallIndex(f.root, f.storeId);
  const index = new RecallIndex(f.root, f.storeId), before = readFileSync(join(f.root, "store.json"));
  try {
    f.store.note(note(project, "New fixture"), randomUUID());
    expect(existsSync(join(f.root, INDEX_FILE))).toBe(false);
    expect(() => index.search("rendering", [project])).toThrow("generation changed");
    expect(readFileSync(join(f.root, "store.json")).equals(before)).toBe(false);
    expect(() => new RecallIndex(f.root, f.storeId)).toThrow();
  } finally { index.close(); }
  rebuildRecallIndex(f.root, f.storeId);
  const reopened = new RecallIndex(f.root, f.storeId); reopened.close();
});

test("purge removes index and interrupted builder remnants; imports invalidate too", () => {
  const f = fixture(), row = f.store.note(note(), randomUUID()); rebuildRecallIndex(f.root, f.storeId);
  const orphan = join(f.root, `${INDEX_TEMP}${randomUUID()}`); writeFileSync(orphan, "Synthetic cached text");
  f.store.purge(row.id, 1, `purge:${row.id}`);
  expect(existsSync(orphan)).toBe(false); expect(existsSync(join(f.root, INDEX_FILE))).toBe(false);
  rebuildRecallIndex(f.root, f.storeId);
  f.store.import(Buffer.from(f.store.export()), false);
  expect(existsSync(join(f.root, INDEX_FILE))).toBe(false);
});

test("pins are scope-bound and bounded, independent of recency; open threads are cues not tasks", () => {
  const f = fixture(), pinned = f.store.note(note(project, "Old stable preference"), randomUUID());
  const secret = f.store.note(note(personal, "Personal pinned preference"), randomUUID());
  f.store.note({ ...note(project, "Unfinished fixture thread"), kind: "thread", threadStatus: "open" }, randomUUID());
  f.store.note({ ...note(project, "Closed fixture thread"), kind: "thread", threadStatus: "resolved" }, randomUUID());
  rebuildRecallIndex(f.root, f.storeId); const index = new RecallIndex(f.root, f.storeId);
  try {
    const result = index.search("nothingmatches", [project], { pins: [pinned.id, secret.id] });
    expect(result.items).toHaveLength(1); expect(result.items[0].reason).toBe("human pin");
    expect(index.search("", [project], { threads: true }).items).toHaveLength(1);
    const packet = makePacket(index.generation, result.items);
    expect(packetText(packet)).toContain("never permission to resume work");
    expect(Buffer.byteLength(packetText(packet))).toBeLessThanOrEqual(8192);
    const huge = { ...result.items[0], body: "狸".repeat(2700) };
    expect(makePacket(index.generation, [huge]).pinOverflow).toBe(true);
    const mixed = makePacket(index.generation, Array.from({ length: 20 }, (_, i) => ({ ...huge, id: randomUUID(), reason: "lexical match" as const, body: `${i}: ${"狸".repeat(500)}` })), 4096);
    expect(mixed.omitted).toBeGreaterThan(0); expect(Buffer.byteLength(packetText(mixed))).toBeLessThanOrEqual(4096);
  } finally { index.close(); }
});

test("aborted builds, wrong store identities, corrupt and symlinked caches fail explicitly", () => {
  const f = fixture(); f.store.note(note(), randomUUID());
  expect(() => rebuildRecallIndex(f.root, randomUUID())).toThrow("identity");
  expect(() => rebuildRecallIndex(f.root, f.storeId, AbortSignal.abort())).toThrow();
  expect(existsSync(join(f.root, INDEX_FILE))).toBe(false);
  writeFileSync(join(f.root, INDEX_FILE), "Not SQLite"); expect(() => new RecallIndex(f.root, f.storeId)).toThrow();
  rmSync(join(f.root, INDEX_FILE)); symlinkSync(join(f.root, "store.json"), join(f.root, INDEX_FILE));
  expect(() => new RecallIndex(f.root, f.storeId)).toThrow("Unavailable");
  const before = f.store.export(); expect(() => f.store.note(note(), randomUUID())).toThrow("non-symlink"); expect(f.store.export()).toBe(before);
  expect(queryTerms('"OR" NEAR(foo) \'bar\'')).toEqual(["near", "foo", "bar"]);
});

test("read-only lookup does not rewrite store/index and returns measured local timings", () => {
  const f = fixture(); for (let i = 0; i < 50; i++) f.store.note(note(project, `Fixture cache ${i}`), randomUUID());
  rebuildRecallIndex(f.root, f.storeId);
  const before = f.store.export(), indexBytes = readFileSync(join(f.root, INDEX_FILE));
  const index = new RecallIndex(f.root, f.storeId);
  try { for (let i = 0; i < 10; i++) expect(index.search("cache", [project]).items).toHaveLength(10); }
  finally { index.close(); }
  expect(f.store.export()).toBe(before); expect(readFileSync(join(f.root, INDEX_FILE))).toEqual(indexBytes);
  expect(decodeTransfer(Buffer.from(before)).revisions).toHaveLength(50);
});
