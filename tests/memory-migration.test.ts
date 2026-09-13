import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectOptmemSnapshot, LOG_RECORD_BYTES, TREE_RECORD_BYTES } from "../lib/memory/legacy-optmem.ts";
import { decodeTransfer, hash, type Note, type Revision, type Scope } from "../lib/memory/schema.ts";
import { MemoryStore } from "../lib/memory/store.ts";

const roots: string[] = [];
const archiveId = "11111111-1111-4111-a111-111111111111";
const project: Scope = "project:22222222-2222-4222-a222-222222222222";
function root() { const r = mkdtempSync(join(tmpdir(), "memory-migration-test-")); roots.push(r); return r; }
function padded(text: string, width: number) { const bytes = Buffer.from(text); if (bytes.length >= width) throw new Error("Fixture too large"); return Buffer.concat([bytes, Buffer.alloc(width - bytes.length - 1, 32), Buffer.from("\n")]); }
function fixture(count = 4) {
  const r = root(); mkdirSync(join(r, "TREE"), { mode: 0o700 });
  writeFileSync(join(r, "LOG.txt"), Buffer.concat(Array.from({ length: count }, (_, i) => padded(`#${i} 2026-01-02 Synthetic 狸 record ${i}`, LOG_RECORD_BYTES))));
  writeFileSync(join(r, "config"), "# This synthetic config is not imported\nWAKE_LINES = 1\n");
  writeFileSync(join(r, ".lock"), "");
  if (count >= 2) writeFileSync(join(r, "TREE", "2"), padded("Synthetic summary, not a raw fact", TREE_RECORD_BYTES));
  return r;
}
function note(row: Revision): Note { const { id: _id, revision: _revision, operation: _operation, createdAt: _created, reason: _reason, ...n } = row; return n; }
const inspect = (r: string, options = {}) => inspectOptmemSnapshot(r, { archiveId, ...options });
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("tools/memory-migrate.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test("reads fixed-width UTF-8 originals and labelled summaries without copying private config or source paths", () => {
  const r = fixture(), before = readFileSync(join(r, "LOG.txt"));
  const plan = inspect(r);
  expect(plan.report).toMatchObject({ rawRecords: 4, summaryRecords: 1, missingSummaries: 2, selectedRecords: 5, unassignedRecords: 5 });
  const first = plan.entries[0].note, summary = plan.entries[4].note;
  expect(first.body).toBe("Synthetic 狸 record 0");
  expect(first.sources[0].excerpt).toBe(before.subarray(0, LOG_RECORD_BYTES).toString("utf8"));
  expect(first.sources[0]).toMatchObject({ timestamp: "2026-01-02", precision: "day", sha256: hash(first.sources[0].excerpt) });
  expect(first.legacy).toMatchObject({ locator: "LOG.txt#0", type: "raw", archiveId });
  expect(summary.kind).toBe("artifact"); expect(summary.sources[0].precision).toBe("unknown");
  expect(summary.sources[0].timestamp).toBeUndefined();
  expect(JSON.stringify(plan)).not.toContain(r); expect(JSON.stringify(plan.entries)).not.toContain("WAKE_LINES");
  expect(JSON.stringify(plan.report)).not.toContain("Synthetic 狸");
  expect(readFileSync(join(r, "LOG.txt"))).toEqual(before);
  expect(readdirSync(r).sort()).toEqual([".lock", "LOG.txt", "TREE", "config"]);
});

test("candidate batch preview is nonpublishing, apply is atomic and retries preserve later review", () => {
  const r = fixture(), destination = new MemoryStore(root()), plan = inspect(r);
  expect(destination.importNotes(plan.entries)).toMatchObject({ added: 5, existing: 0, dryRun: true });
  expect(existsSync(join(destination.root, "store.json"))).toBe(false);
  destination.importNotes(plan.entries, false);
  expect(destination.search("synthetic", ["unassigned"]).items).toHaveLength(0);
  expect(destination.list(["unassigned"]).items).toHaveLength(5);
  const initial = destination.read(plan.entries[0].operation, ["unassigned"]);
  const classified = destination.revise(initial.id, 1, { ...note(initial), scope: project }, "Human classification", randomUUID());
  destination.revise(initial.id, 2, { ...note(classified), status: "accepted" }, "Human review", randomUUID());
  expect(destination.importNotes(plan.entries, false)).toMatchObject({ added: 0, existing: 5, revisions: 7 });
  expect(destination.read(initial.id, [project]).status).toBe("accepted");
  expect(() => destination.read(initial.id, ["unassigned"])).toThrow("allowed scopes");
  expect(destination.read(initial.id, ["unassigned"], 1)).toEqual(initial);
  expect(destination.search("synthetic", [project]).items).toHaveLength(1);
  expect(destination.search("synthetic", ["unassigned"]).items).toHaveLength(0);
});

test("unassigned records and summaries cannot bypass review or become accepted facts", () => {
  const plan = inspect(fixture()), store = new MemoryStore(root()); store.importNotes(plan.entries, false);
  const initial = store.read(plan.entries[0].operation, ["unassigned"]);
  expect(() => store.revise(initial.id, 1, { ...note(initial), status: "accepted" }, "Skip scope", randomUUID())).toThrow("cannot be accepted");
  expect(() => store.revise(initial.id, 1, { ...note(initial), scope: project, status: "accepted" }, "Skip review", randomUUID())).toThrow("identity");
  const summary = store.read(plan.entries[4].operation, ["unassigned"]);
  expect(() => store.revise(summary.id, 1, { ...note(summary), kind: "fact" }, "Promote", randomUUID())).toThrow();
  expect(() => store.revise(summary.id, 1, { ...note(summary), status: "accepted" }, "Promote", randomUUID())).toThrow("cannot be accepted");
  expect(() => store.revise(initial.id, 1, { ...note(initial), sources: [] }, "Drop original", randomUUID())).toThrow("must be retained");
});

test("archive identity and per-record hashes detect source rewrite, append stays idempotent", () => {
  const r = fixture(2), plan = inspect(r), store = new MemoryStore(root()); store.importNotes(plan.entries, false);
  writeFileSync(join(r, "LOG.txt"), Buffer.concat([readFileSync(join(r, "LOG.txt")), padded("#2 2026-01-03 Synthetic addition", LOG_RECORD_BYTES)]));
  const appended = inspect(r);
  expect(appended.report.digest).not.toBe(plan.report.digest);
  expect(store.importNotes(appended.entries, false)).toMatchObject({ added: 1, existing: 3 });
  const before = store.export(), bytes = readFileSync(join(r, "LOG.txt"));
  padded("#0 2026-01-02 Changed original", LOG_RECORD_BYTES).copy(bytes); writeFileSync(join(r, "LOG.txt"), bytes);
  expect(() => store.importNotes(inspect(r).entries, false)).toThrow("source conflict");
  expect(store.export()).toBe(before);
  expect(inspect(r, { archiveId: randomUUID() }).entries[0].operation).not.toBe(plan.entries[0].operation);
});

test("copied snapshot restores every selected original, summary and provenance without OptMem", () => {
  const r = fixture(), plan = inspect(r), store = new MemoryStore(root()); store.importNotes(plan.entries, false);
  const exported = store.export(), restored = new MemoryStore(root()); restored.import(Buffer.from(exported), false);
  expect(restored.export()).toBe(exported);
  for (const entry of plan.entries) expect(note(restored.read(entry.operation, ["unassigned"]))).toEqual(entry.note);
  expect(decodeTransfer(Buffer.from(exported)).revisions).toHaveLength(5);
});

test("missing and blank summaries do not block raw import or trigger compression", () => {
  const r = fixture(); writeFileSync(join(r, "TREE", "2"), padded("", TREE_RECORD_BYTES));
  const blank = inspect(r);
  expect(blank.report).toMatchObject({ blankSummaries: 1, summaryRecords: 0, missingSummaries: 3, selectedRecords: 4 });
  rmSync(join(r, "TREE"), { recursive: true });
  const absent = inspect(r);
  expect(absent.report.treePresent).toBe(false); expect(absent.entries).toHaveLength(4);
});

test("scope and summary selection are bound into approval digest; duplicate text is retained and counted", () => {
  const r = fixture(2), log = Buffer.concat([0, 1].map(i => padded(`#${i} 2026-01-02 Duplicate synthetic original`, LOG_RECORD_BYTES)));
  writeFileSync(join(r, "LOG.txt"), log);
  const a = inspect(r), b = inspect(r, { includeSummaries: false }), c = inspect(r, { targetScope: project });
  expect(a.report.duplicateRawBodies).toBe(1); expect(a.entries).toHaveLength(3);
  expect(b.entries).toHaveLength(2); expect(b.report.summaryRecords).toBe(1);
  expect(a.report.digest).not.toBe(b.report.digest); expect(a.report.digest).not.toBe(c.report.digest);
  expect(c.entries.every(e => e.note.scope === project && e.note.status === "candidate")).toBe(true);
});

test("malformed, unknown and symlinked archives fail explicitly without repairing or writing them", () => {
  const r = fixture(), log = join(r, "LOG.txt"), original = readFileSync(log);
  for (const bad of [Buffer.from("plain export is not the fixed-width format\n"), original.subarray(0, -1), Buffer.concat([padded("#7 2026-01-02 Wrong position", LOG_RECORD_BYTES), original.subarray(LOG_RECORD_BYTES)]), Buffer.concat([padded("#0 2026-02-31 Invalid date", LOG_RECORD_BYTES), original.subarray(LOG_RECORD_BYTES)])]) {
    writeFileSync(log, bad); expect(() => inspect(r)).toThrow(); expect(readFileSync(log)).toEqual(bad);
  }
  const invalidUtf8 = Buffer.from(original); invalidUtf8[40] = 255; writeFileSync(log, invalidUtf8); expect(() => inspect(r)).toThrow("UTF-8");
  writeFileSync(log, original); writeFileSync(join(r, "unexpected.json"), "{}"); expect(() => inspect(r)).toThrow("layout"); rmSync(join(r, "unexpected.json"));
  writeFileSync(join(r, "TREE", "3"), ""); expect(() => inspect(r)).toThrow("level"); rmSync(join(r, "TREE", "3"));
  writeFileSync(join(r, "TREE", "2"), "partial"); expect(() => inspect(r)).toThrow("Partial TREE");
  writeFileSync(join(r, "TREE", "2"), Buffer.concat(Array.from({ length: 3 }, () => padded("Too many records", TREE_RECORD_BYTES)))); expect(() => inspect(r)).toThrow("bounded regular");
  rmSync(log); const elsewhere = join(root(), "external"); writeFileSync(elsewhere, original); symlinkSync(elsewhere, log); expect(() => inspect(r)).toThrow();
  const alias = join(root(), "alias"); symlinkSync(r, alias); expect(() => inspect(alias)).toThrow("real directories");
});

test("batch conflicts never publish earlier valid candidates", () => {
  const plan = inspect(fixture()), store = new MemoryStore(root()); store.importNotes(plan.entries.slice(0, 1), false);
  const before = store.export(), conflicting = structuredClone(plan.entries[0]); conflicting.note.body = "Conflicting content";
  expect(() => store.importNotes([plan.entries[1], conflicting], false)).toThrow("conflict");
  expect(store.export()).toBe(before);
  expect(() => store.importNotes([plan.entries[1], plan.entries[1]], false)).toThrow("Duplicate");
  expect(store.export()).toBe(before);
});

test("full 1024-raw archive fits beyond the original prototype quota and exports fully through a pipe", async () => {
  const plan = inspect(fixture(1024)), store = new MemoryStore(root());
  const result = store.importNotes(plan.entries, false);
  expect(result.added).toBe(1025);
  expect(store.list(["unassigned"], { offset: 1020, limit: 20 }).items).toHaveLength(5);
  expect(store.export()).not.toContain("WAKE_LINES");
  const child = Bun.spawn([process.execPath, resolve("tools/memory-inspect.ts"), "export", store.root], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exit).toBe(0); expect(stdout.trim()).toBe(store.export());
});

test("maximum supported complete archive imports without dropping originals or summaries", () => {
  const r = fixture(4096);
  for (let size = 2; size <= 4096; size *= 2) {
    writeFileSync(join(r, "TREE", String(size)), Buffer.concat(Array.from({ length: 4096 / size }, (_, i) => padded(`Synthetic level ${size} block ${i}`, TREE_RECORD_BYTES))));
  }
  const plan = inspect(r), store = new MemoryStore(root());
  expect(plan.report).toMatchObject({ rawRecords: 4096, summaryRecords: 4095, missingSummaries: 0, selectedRecords: 8191 });
  expect(store.importNotes(plan.entries, false).added).toBe(8191);
  const snapshot = decodeTransfer(Buffer.from(store.export()));
  expect(snapshot.revisions.filter(r => r.legacy?.type === "raw")).toHaveLength(4096);
  expect(snapshot.revisions.filter(r => r.legacy?.type === "summary")).toHaveLength(4095);
}, 15000);

test("purge removes originals, blocks backup resurrection and skips reimported source identities", () => {
  const plan = inspect(fixture()), store = new MemoryStore(root()); store.importNotes(plan.entries, false);
  const original = store.read(plan.entries[0].operation, ["unassigned"]), oldBackup = store.export();
  expect(() => store.purge(original.id, 1, "yes")).toThrow("confirmation");
  expect(() => store.purge(original.id, 2, `purge:${original.id}`)).toThrow("conflict");
  expect(store.purge(original.id, 1, `purge:${original.id}`)).toMatchObject({ removedRevisions: 1 });
  expect(() => store.read(original.id, ["unassigned"])).toThrow("not found");
  expect(store.export()).not.toContain(original.body);
  expect(store.purge(original.id, 1, `purge:${original.id}`).alreadyPurged).toBe(true);
  expect(() => store.import(Buffer.from(oldBackup), false)).toThrow("purge tombstones");
  expect(store.importNotes(plan.entries, false)).toMatchObject({ skippedPurged: 1, added: 0, existing: 4 });
  expect(() => store.note(plan.entries[0].note, plan.entries[0].operation)).toThrow("purged");
  const restored = new MemoryStore(root()); restored.import(Buffer.from(store.export()), false);
  expect(restored.importNotes(plan.entries, false).skippedPurged).toBe(1);
  expect(restored.export()).not.toContain(original.body);
  const oldCopy = new MemoryStore(root()); oldCopy.import(Buffer.from(oldBackup), false);
  expect(() => oldCopy.import(Buffer.from(store.export()), false)).toThrow("purge tombstones");
  expect(oldCopy.export()).toBe(oldBackup); // importing a tombstone cannot silently delete local records
});

test("CLI dry-run/apply is digest-gated, text-free by default, and explicit review is revision-safe", async () => {
  const r = fixture(), target = root();
  const preview = await cli("import", r, archiveId, target);
  expect(preview.exit).toBe(0); expect(preview.stdout).not.toContain("Synthetic 狸");
  expect(existsSync(join(target, "store.json"))).toBe(false);
  const digest = JSON.parse(preview.stdout).digest;
  expect((await cli("import", r, archiveId, target, "--apply", "a".repeat(64))).exit).toBe(1);
  expect(existsSync(join(target, "store.json"))).toBe(false);
  const applied = await cli("import", r, archiveId, target, "--apply", digest);
  expect(applied.stderr).toBe(""); expect(applied.exit).toBe(0);
  const reviewed = await cli("review", target, "unassigned"); expect(reviewed.exit).toBe(0);
  const record = inspect(r).entries[0].operation, classifyOp = randomUUID();
  expect((await cli("classify", target, record, "1", project, classifyOp, "--apply")).exit).toBe(0);
  expect((await cli("classify", target, record, "1", project, classifyOp, "--apply")).exit).toBe(0);
  expect((await cli("accept", target, project, record, "1", randomUUID(), "--apply")).exit).toBe(1);
  const acceptOp = randomUUID();
  expect((await cli("accept", target, project, record, "2", acceptOp, "--apply")).exit).toBe(0);
  expect((await cli("accept", target, project, record, "2", acceptOp, "--apply")).exit).toBe(0);
  expect(new MemoryStore(target).read(record, [project]).status).toBe("accepted");
  expect((await cli("import", r, archiveId, r)).exit).toBe(1);
  expect((await cli("import", r, archiveId, target, "--apply")).exit).toBe(1);
  expect((await cli("import", r, archiveId, target, "--raw-only", "--apply", digest)).exit).toBe(1);
  const purgePreview = await cli("purge", target, project, record);
  expect(JSON.parse(purgePreview.stdout).dryRun).toBe(true);
  expect((await cli("purge", target, project, record, "3", "--confirm", `purge:${record}`)).exit).toBe(0);
  expect(() => new MemoryStore(target).read(record, [project])).toThrow("not found");
  expect(new MemoryStore(target).search("synthetic", [project]).items).toHaveLength(0);
});
