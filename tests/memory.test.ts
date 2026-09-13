import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, decodeTransfer, encodeTransfer, hash, MAX_REVISIONS, STORE_BYTES, type Note, type Scope } from "../lib/memory/schema.ts";
import { MemoryStore } from "../lib/memory/store.ts";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "memory-test-")); chmodSync(path, 0o700); roots.push(path); return path; }
function store() { const s = new MemoryStore(root()); s.initialize(); return s; }
const project: Scope = `project:${randomUUID()}`, other: Scope = `project:${randomUUID()}`, personal: Scope = `personal:${randomUUID()}`;
function note(overrides: Partial<Note> = {}): Note { return { scope: project, kind: "fact", title: "Cache decision", body: "Preserve append-only snapshots, with unverified provider behavior.", author: "assistant", status: "accepted", sources: [], ...overrides }; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("portable memory prototype", () => {
  test("initialize is explicit, stable and independent of Pi", () => {
    const path = root(), s = new MemoryStore(path);
    expect(existsSync(join(path, "store.json"))).toBe(false);
    expect(() => s.search("cache", [project])).toThrow();
    expect(s.initialize()).toBe(s.initialize());
    expect(new MemoryStore(path).export()).toBe(s.export());
  });
  test("immutable revisions, exact retries and stale-writer rejection", () => {
    const s = store(), op = randomUUID(), first = s.note(note(), op);
    expect(s.note(note(), op)).toEqual(first);
    expect(() => s.note(note({ body: "Different" }), op)).toThrow("Operation conflict");
    const correction = note({ body: "Not anymore: retain only the current packet." }), revisionOp = randomUUID();
    const second = s.revise(first.id, 1, correction, "User correction", revisionOp);
    expect(second.revision).toBe(2);
    expect(s.revise(first.id, 1, correction, "User correction", revisionOp)).toEqual(second);
    expect(s.read(first.id, [project], 1)).toEqual(first);
    expect(s.read(first.id, [project])).toEqual(second);
    expect(() => s.revise(first.id, 1, note(), "stale", randomUUID())).toThrow("Revision conflict");
    expect(s.search("not anymore", [project]).items).toHaveLength(1);
    expect(s.search("unverified", [project]).items).toHaveLength(0);
  });
  test("scope filtering precedes search and direct reads", () => {
    const s = store();
    const a = s.note(note(), randomUUID());
    s.note(note({ scope: other }), randomUUID()); s.note(note({ scope: personal }), randomUUID());
    expect(s.search("cache", [project]).items.map(r => r.id)).toEqual([a.id]);
    expect(s.search("cache", []).items).toHaveLength(0);
    expect(() => s.read(a.id, [personal])).toThrow("allowed scopes");
    expect(() => s.search("cache", ["global" as Scope])).toThrow();
    expect(() => s.search("cache", [`${project}\n` as Scope])).toThrow("UUID");
  });
  test("candidates are opt-in and retraction hides latest without erasing history", () => {
    const s = store(), initial = note({ status: "candidate" });
    const row = s.note(initial, randomUUID());
    expect(s.search("cache", [project]).items).toHaveLength(0);
    expect(s.search("cache", [project], { candidates: true }).items).toHaveLength(1);
    s.revise(row.id, 1, note({ status: "retracted" }), "Withdrawn", randomUUID());
    expect(s.search("cache", [project], { candidates: true }).items).toHaveLength(0);
    expect(s.read(row.id, [project], 1).status).toBe("candidate");
    expect(s.read(row.id, [project]).status).toBe("retracted");
  });
  test("retained reflective originals round-trip byte-for-byte", () => {
    const s = store(), passage = "A room, not a script. 明狸\nStill unfinished.";
    const row = s.note(note({ kind: "reflection", body: passage, sources: [{ id: randomUUID(), author: "assistant", timestamp: new Date().toISOString(), excerpt: passage, sha256: hash(passage) }] }), randomUUID());
    const exported = s.export(), restored = new MemoryStore(root());
    expect(restored.import(Buffer.from(exported))).toMatchObject({ dryRun: true, added: 1 });
    expect(existsSync(join(restored.root, "store.json"))).toBe(false);
    restored.import(Buffer.from(exported), false);
    expect(restored.read(row.id, [project])).toEqual(row);
    expect(restored.export()).toBe(exported);
    expect(restored.import(Buffer.from(exported), false).added).toBe(0);
  });
  test("incremental same-store merge preserves local records", () => {
    const a = store(), row = a.note(note(), randomUUID()), b = new MemoryStore(root());
    b.import(Buffer.from(a.export()), false);
    b.note(note({ title: "Local" }), randomUUID());
    a.revise(row.id, 1, note({ body: "Correction" }), "Correction", randomUUID());
    expect(b.import(Buffer.from(a.export()), false).added).toBe(1);
    expect(b.search("cache", [project]).items).toHaveLength(1);
    expect(b.search("local", [project]).items).toHaveLength(1);
  });
  test("conflicts, unknown schemas, malformed chains and hashes never partially publish", () => {
    const s = store(); s.note(note(), randomUUID());
    const original = s.export(), snapshot = decodeTransfer(Buffer.from(original));
    snapshot.revisions[0].body = "Conflicting original";
    expect(() => s.import(Buffer.from(encodeTransfer(snapshot)), false)).toThrow("conflict");
    const envelope = JSON.parse(original); envelope.snapshot.revisions[0].body = "Tampering";
    expect(() => s.import(Buffer.from(JSON.stringify(envelope)), false)).toThrow("hash mismatch");
    envelope.version = 2;
    expect(() => s.import(Buffer.from(JSON.stringify(envelope)), false)).toThrow("format");
    snapshot.revisions[0].revision = 2;
    expect(() => encodeTransfer(snapshot)).toThrow("chain");
    expect(() => s.import(Buffer.from(store().export()), false)).toThrow("Different store");
    expect(s.export()).toBe(original);
  });
  test("bounds, unknown fields, source hashes, thread kinds and stable identity", () => {
    const s = store();
    expect(() => s.note(note({ body: "狸".repeat(2731) }), randomUUID())).toThrow("8192");
    expect(() => s.note({ ...note(), surprise: "not accepted" } as Note, randomUUID())).toThrow("unknown fields");
    expect(() => s.note(note({ body: "\ud800" }), randomUUID())).toThrow("UTF-8");
    expect(() => s.note(note({ kind: "thread" }), randomUUID())).toThrow("thread status");
    expect(() => s.note(note({ sources: [{ id: randomUUID(), author: "user", timestamp: new Date().toISOString(), excerpt: "Original", sha256: hash("Other") }] }), randomUUID())).toThrow("hash mismatch");
    expect(() => s.note(note({ author: "import" }), randomUUID())).toThrow("candidates");
    const row = s.note(note({ kind: "thread", threadStatus: "dormant" }), randomUUID());
    expect(() => s.revise(row.id, 1, note(), "Change kind", randomUUID())).toThrow("identity");
    expect(() => s.revise(row.id, 1, note({ kind: "thread", threadStatus: "open", scope: other }), "Move", randomUUID())).toThrow("identity");
  });
  test("bounded deterministic metadata pagination and empty queries", () => {
    const s = store(); for (let i = 0; i < 4; i++) s.note(note(), randomUUID());
    const first = s.search("cache", [project], { limit: 2 });
    const second = s.search("cache", [project], { limit: 2, offset: first.nextOffset! });
    expect(new Set([...first.items, ...second.items].map(r => r.id)).size).toBe(4);
    expect(second.nextOffset).toBeNull(); expect(first.items[0]).not.toHaveProperty("body");
    expect(s.search("!!!", [project]).items).toEqual([]);
    expect(() => s.search("a", [project], { limit: 21 })).toThrow("bounds");
  });
  test("quota refusal preserves all originals", () => {
    const s = store(), snapshot = decodeTransfer(Buffer.from(s.export()));
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_REVISIONS; i++) snapshot.revisions.push({ ...note(), id: randomUUID(), revision: 1, operation: randomUUID(), createdAt: now, reason: "Fixture" });
    s.import(Buffer.from(encodeTransfer(snapshot)), false);
    const before = s.export();
    expect(() => s.note(note(), randomUUID())).toThrow("quota");
    expect(s.export()).toBe(before);
  });
  test("interrupted locks fail closed, orphan temporaries do not replace originals", () => {
    const s = store(), before = s.export();
    writeFileSync(join(s.root, ".pending-interrupted"), "invalid");
    mkdirSync(join(s.root, ".writer-lock"));
    expect(() => s.note(note(), randomUUID())).toThrow("never automatically stolen");
    expect(s.export()).toBe(before);
  });
  test("symlink paths and oversized/nonregular input are refused", () => {
    const s = store(), path = root(), alias = join(path, "alias");
    symlinkSync(s.root, alias);
    expect(() => new MemoryStore(alias)).toThrow("real directories");
    const target = join(s.root, "store.json"), original = readFileSync(target);
    rmSync(target); symlinkSync(join(path, "missing"), target);
    expect(() => s.initialize()).toThrow();
    expect(existsSync(join(path, "missing"))).toBe(false);
    rmSync(target); mkdirSync(target);
    expect(() => s.export()).toThrow("regular file");
    rmSync(target, { recursive: true }); writeFileSync(target, Buffer.alloc(STORE_BYTES + 1));
    expect(() => s.export()).toThrow("regular file");
    writeFileSync(target, original);
    expect(() => s.import(Buffer.alloc(STORE_BYTES + 1025), false)).toThrow("limit");
  });
  test("two real processes cannot both publish the same expected revision", async () => {
    const s = store(), row = s.note(note(), randomUUID());
    const code = `import {MemoryStore} from ${JSON.stringify(resolve("lib/memory/store.ts"))}; const s=new MemoryStore(process.argv[1]); try { s.revise(${JSON.stringify(row.id)},1,${JSON.stringify(note({ body: "Concurrent correction" }))},"Race",crypto.randomUUID()); } catch { process.exit(2); }`;
    const children = [1, 2].map(() => Bun.spawn([process.execPath, "--eval", code, s.root], { stdout: "pipe", stderr: "pipe" }));
    const exits = await Promise.all(children.map(c => c.exited));
    expect(exits.sort()).toEqual([0, 2]);
    expect(s.read(row.id, [project]).revision).toBe(2);
    expect(decodeTransfer(Buffer.from(s.export())).revisions).toHaveLength(2);
  });
  test("directory flush failure is not acknowledged, including identical retries", async () => {
    const path = root();
    const code = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const original = { ...fs }; let fail = false;
      mock.module("node:fs", () => ({ ...original, fsyncSync(fd) {
        if (fail && original.fstatSync(fd).isDirectory()) throw new Error("injected directory flush failure");
        original.fsyncSync(fd);
      }}));
      const {MemoryStore} = await import(${JSON.stringify(resolve("lib/memory/store.ts"))});
      const s = new MemoryStore(process.argv[1]); s.initialize();
      const op = crypto.randomUUID(), note = ${JSON.stringify(note())};
      fail = true;
      for (let i = 0; i < 2; i++) {
        let rejected = false;
        try { s.note(note, op); } catch (e) { if (!e.message.includes("injected")) throw e; rejected = true; }
        if (!rejected) throw new Error("acknowledged failed directory flush");
      }
      fail = false; s.note(note, op);
      if (s.search("cache", [note.scope]).items.length !== 1) throw new Error("duplicate/lost retry");
    `;
    const child = Bun.spawn([process.execPath, "--eval", code, path], { stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
  });
  test("standalone inspector validates exports and reads scoped originals without Pi", async () => {
    const s = store(), row = s.note(note(), randomUUID()), transfer = join(root(), "export.json");
    writeFileSync(transfer, s.export());
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve("tools/memory-inspect.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, stdout, stderr };
    };
    const validation = await run("validate", transfer);
    expect(validation.exit).toBe(0); expect(JSON.parse(validation.stdout).revisions).toBe(1);
    const reading = await run("read", s.root, project, row.id);
    expect(reading.exit).toBe(0); expect(JSON.parse(reading.stdout)).toEqual(row);
    expect((await run("read", s.root, personal, row.id)).exit).toBe(1);
    const searching = await run("search", s.root, project, "cache");
    expect(JSON.parse(searching.stdout).items[0].id).toBe(row.id);
    const exported = await run("export", s.root);
    expect(exported.stdout.trim()).toBe(s.export());
    expect((await run("validate", transfer, "extra")).exit).toBe(1);
  });
  test("version 1 originals remain readable and upgrade only on explicit writes", () => {
    const s = store(), row = s.note(note(), randomUUID());
    const old = decodeTransfer(Buffer.from(s.export())); old.version = 1;
    writeFileSync(join(s.root, "store.json"), canonical(old));
    expect(s.read(row.id, [project])).toEqual(row);
    expect(decodeTransfer(Buffer.from(s.export())).version).toBe(1);
    s.note(note({ title: "Schema upgrade" }), randomUUID());
    expect(decodeTransfer(Buffer.from(s.export())).version).toBe(3);
    expect(s.read(row.id, [project])).toEqual(row);
    const restored = new MemoryStore(root()); restored.import(Buffer.from(encodeTransfer(old)), false);
    expect(restored.read(row.id, [project])).toEqual(row);
    expect(decodeTransfer(Buffer.from(restored.export())).version).toBe(3);
  });
  test("canonical serialization is key-order independent, not array-order independent", () => {
    expect(canonical({ z: 1, a: [2, 1] })).toBe(canonical({ a: [2, 1], z: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
