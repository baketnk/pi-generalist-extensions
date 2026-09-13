import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyChunks, MAX_PATCH_BYTES, parsePatch } from "../lib/patch/parser.ts";
import { executePatch, MAX_FILE_BYTES } from "../lib/patch/engine.ts";

const roots: string[] = [];
async function fixture(files: Record<string, string | Buffer> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "generalist-patch-test-")); roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(root, name, ".."), { recursive: true });
    await fs.writeFile(join(root, name), content);
  }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const update = (path: string, old = "old", next = "new") => `*** Update File: ${path}\n@@\n-${old}\n+${next}`;
function transform(source: string, body: string, warnings: string[] = []) {
  const file = parsePatch(patch(`*** Update File: a\n${body}`))[0]!;
  if (file.kind !== "update") throw new Error("fixture");
  return applyChunks(source, file.chunks, warnings);
}

test("parses add/delete/update/move, several chunks and paths with spaces", () => {
  const files = parsePatch(patch("*** Add File: a b\n+x\n*** Delete File: old\n*** Update File: a\n*** Move to: c\n@@ fn\n-x\n+y\n@@\n-z\n+w\n*** End of File"));
  expect(files).toHaveLength(3);
  expect(files[0]).toEqual({ kind: "add", path: "a b", content: "x\n" });
  expect(files[2]?.kind).toBe("update");
});

test("rejects malformed/no-op/oversize patches and unsupported wrappers", () => {
  for (const input of ["", patch(""), patch("*** Update File: a"),
    patch("*** Add File: a\nx"), patch("*** Delete File: a\n-contents"), patch("*** Update File: a\n@@ -1 +1 @@\n-x\n+y"),
    patch("*** Update File: a\n@@\n-x\n+y\n*** End of File\n@@\n-x\n+y"), patch("*** Add File: a\n+\0"),
    "```\n" + patch("*** Add File: a\n+x") + "\n```", "x".repeat(MAX_PATCH_BYTES + 1),
    patch(Array.from({ length: 33 }, (_, i) => `*** Add File: ${i}\n+x`).join("\n"))]) {
    expect(() => parsePatch(input)).toThrow();
  }
});

test("ignores empty and context-only chunks with explicit warnings", () => {
  const warnings: string[] = [];
  const files = parsePatch(patch("*** Update File: a\n@@\n context\n@@\n@@\n-old\n+new"), warnings);
  expect(files).toEqual([{ kind: "update", path: "a", chunks: [{ lines: [
    { kind: "-", text: "old" }, { kind: "+", text: "new" },
  ], eof: false }] }]);
  expect(warnings).toEqual([
    "a: ignored context-only chunk beginning at patch line 3.",
    "a: ignored empty chunk beginning at patch line 5.",
  ]);
});

test("updates chunks against original coordinates and preserves mixed endings/BOM/EOF", () => {
  const source = "\uFEFFfirst\r\nold\nkeep\r\nlast";
  expect(transform(source, "@@\n first\n-old\n+new\n keep\n@@\n-last\n+tail")).toBe("\uFEFFfirst\r\nnew\r\nkeep\r\ntail");
  expect(transform("old\n", "@@\n-old\n+new")).toBe("new\n");
  expect(transform("old", "@@\n-old\n+new")).toBe("new");
  expect(transform("old\r", "@@\n-old\n+new")).toBe("new\r");
});

test("insertion before/after context, append, empty file, deletion to empty", () => {
  expect(transform("a\nb\n", "@@\n a\n+x\n b")).toBe("a\nx\nb\n");
  expect(transform("a", "@@\n+last")).toBe("a\nlast");
  expect(transform("", "@@\n+first")).toBe("first\n");
  expect(transform("a\n", "@@\n-a")).toBe("");
  expect(transform("a\nb\n", "@@\n+first\n a")).toBe("first\na\nb\n");
});

test("EOF restricts matching and @@ literal context disambiguates a chunk", () => {
  expect(transform("a\nx\nb\nx\n", "@@ b\n-x\n+y")).toBe("a\nx\nb\ny\n");
  expect(transform("x\nx\n", "@@\n-x\n+y\n*** End of File")).toBe("x\ny\n");
  expect(() => transform("x\ny\n", "@@\n-x\n+z\n*** End of File")).toThrow("not found");
  expect(() => transform("x\nx\n", "@@\n-x\n+y")).toThrow("Ambiguous");
});

test("matching uses Codex tiers, exact takes priority, preserved context is never normalized", () => {
  const warnings: string[] = [];
  expect(transform("  heading  \r\n  old \r\n", "@@\n heading\n-old\n+  new", warnings)).toBe("  heading  \r\n  new\r\n");
  expect(warnings[0]).toContain("leading/trailing whitespace");
  const trailing: string[] = [];
  expect(transform("old  \n", "@@\n-old\n+new", trailing)).toBe("new\n");
  expect(trailing[0]).toContain("trailing whitespace");
  const unicode: string[] = [];
  expect(transform("“context”—\n‘old’\n", '@@\n "context"-\n-\'old\'\n+new', unicode)).toBe("“context”—\nnew\n");
  expect(unicode[0]).toContain("Unicode punctuation");
  const exact: string[] = [];
  expect(transform("old  \nold\n", "@@\n-old\n+new", exact)).toBe("old  \nnew\n");
  expect(exact).toEqual([]);
  expect(() => transform("old \nold  \n", "@@\n-old\n+new")).toThrow("Ambiguous");
});

test("multi-file add/update/delete/move commits with hashes and actual diffs", async () => {
  const root = await fixture({ a: "old\n", gone: "delete\n", move: "old" });
  await fs.chmod(join(root, "a"), 0o755);
  const result = await executePatch(root, patch(`${update("a")}\n*** Add File: nested/new file\n+hello\n*** Delete File: gone\n*** Update File: move\n*** Move to: nested/moved\n@@\n-old\n+new`));
  expect(result.status).toBe("applied");
  expect(result.committed).toHaveLength(5);
  expect(result.pending).toEqual([]);
  expect(result.committed[0]?.before).toHaveLength(64);
  expect(result.diff).toContain("+new");
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("new\n");
  expect((await fs.stat(join(root, "a"))).mode & 0o777).toBe(0o755);
  expect(await fs.readFile(join(root, "nested/new file"), "utf8")).toBe("hello\n");
  expect(await fs.readFile(join(root, "nested/moved"), "utf8")).toBe("new");
  expect(await fs.readdir(root)).not.toContain("move");
  expect(await fs.readdir(root)).not.toContain("gone");
  expect((await fs.readdir(join(root, "nested"))).some(n => n.endsWith(".tmp"))).toBe(false);
});

test("a later preflight failure leaves all destinations unchanged and creates no directories", async () => {
  const root = await fixture({ a: "old", b: "different" });
  const result = await executePatch(root, patch(`*** Add File: nested/new\n+hi\n${update("a")}\n${update("b")}`));
  expect(result.status).toBe("rejected");
  expect(result.committed).toEqual([]);
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("old");
  expect((await fs.readdir(root)).sort()).toEqual(["a", "b"]);
});

test("no-clobber add/move, duplicate paths, move chains, parent targets, traversal, .git", async () => {
  const root = await fixture({ a: "old", b: "old" });
  for (const body of ["*** Add File: a\n+x", "*** Update File: a\n*** Move to: b", `${update("a")}\n${update("./a")}`,
    "*** Update File: a\n*** Move to: c\n*** Update File: c\n*** Move to: d", "*** Add File: c\n+x\n*** Add File: c/d\n+y",
    "*** Add File: ../escape\n+x", "*** Add File: .git/config\n+x"]) {
    const result = await executePatch(root, patch(body));
    expect(result.status).toBe("rejected"); expect(result.committed).toEqual([]);
  }
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("old");
});

test("rejects symlinks (including dangling and parent), hardlinks, directories, invalid UTF-8 and size limits", async () => {
  const root = await fixture({ a: "old", bad: Buffer.from([0xff]), nul: Buffer.from([0]), big: Buffer.alloc(MAX_FILE_BYTES + 1, 97) });
  await fs.symlink(join(root, "a"), join(root, "sym"));
  await fs.symlink(join(root, "missing"), join(root, "dangling"));
  await fs.mkdir(join(root, "dir")); await fs.symlink(join(root, "dir"), join(root, "parent"));
  await fs.link(join(root, "a"), join(root, "hard"));
  for (const name of ["a", "sym", "dangling", "dir", "bad", "nul", "big"]) {
    expect((await executePatch(root, patch(update(name)))).status).toBe("rejected");
  }
  expect((await executePatch(root, patch("*** Add File: parent/new\n+x"))).status).toBe("rejected");
});

test("move-only and empty Add File are supported", async () => {
  const root = await fixture({ a: "unchanged\r\n" });
  expect((await executePatch(root, patch("*** Update File: a\n*** Move to: b\n*** Add File: empty"))).status).toBe("applied");
  expect(await fs.readFile(join(root, "b"), "utf8")).toBe("unchanged\r\n");
  expect((await fs.stat(join(root, "empty"))).size).toBe(0);
});

test("provable no-ops succeed without writes and coexist with real changes", async () => {
  const root = await fixture({ a: "same\n", b: "old\n" });
  const before = await fs.stat(join(root, "a"));
  const noop = await executePatch(root, patch("*** Update File: a\n@@\n same"));
  const after = await fs.stat(join(root, "a"));
  expect(noop.status).toBe("noop");
  expect(noop.committed).toEqual([]);
  expect(noop.diff).toBe("");
  expect(noop.warnings.join("\n")).toContain("ignored context-only chunk");
  expect(noop.warnings.join("\n")).toContain("no write performed");
  expect(after.ino).toBe(before.ino);

  const sameReplacement = await executePatch(root, patch("*** Update File: a\n@@\n-same\n+same"));
  expect(sameReplacement.status).toBe("noop");
  expect(sameReplacement.warnings.join("\n")).toContain("content identical");
  expect((await fs.stat(join(root, "a"))).ino).toBe(before.ino);

  const mixed = await executePatch(root, patch("*** Update File: a\n@@\n context only\n*** Update File: b\n@@\n-old\n+new"));
  expect(mixed.status).toBe("applied");
  expect(mixed.committed.map(change => change.path)).toEqual(["b"]);
  expect(mixed.warnings.join("\n")).toContain("ignored context-only chunk");
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("same\n");
  expect(await fs.readFile(join(root, "b"), "utf8")).toBe("new\n");

  const rejected = await executePatch(root, patch("*** Update File: a\n@@\n harmless context\n*** Update File: b\n@@\n-missing\n+changed"));
  expect(rejected.status).toBe("rejected");
  expect(rejected.error).toContain("Expected lines not found");
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("same\n");
  expect(await fs.readFile(join(root, "b"), "utf8")).toBe("new\n");
});

test("late conflicts report partial commits and never overwrite outside changes", async () => {
  const root = await fixture({ a: "old", b: "old" });
  const result = await executePatch(root, patch(`${update("a")}\n${update("b")}`), {
    beforeCommit: async index => { if (index === 1) await fs.writeFile(join(root, "b"), "user change"); },
  });
  expect(result.status).toBe("partial");
  expect(result.committed.map(c => c.path)).toEqual(["a"]);
  expect(result.pending).toEqual(["b"]);
  expect(await fs.readFile(join(root, "b"), "utf8")).toBe("user change");
  expect((await fs.readdir(root)).filter(n => n.endsWith(".tmp"))).toEqual([]);
});

test("cancellation before execution, before first commit, and between commits", async () => {
  const root = await fixture({ a: "old", b: "old" });
  const aborted = new AbortController(); aborted.abort();
  expect((await executePatch(root, patch(update("a")), { signal: aborted.signal })).status).toBe("rejected");
  const first = new AbortController();
  const rejected = await executePatch(root, patch("*** Add File: nested/new\n+x"), {
    signal: first.signal, beforeCommit: async () => { first.abort(); },
  });
  expect(rejected.status).toBe("rejected"); expect(await fs.readdir(root)).not.toContain("nested");
  const partial = new AbortController();
  const result = await executePatch(root, patch(`${update("a")}\n${update("b")}`), {
    signal: partial.signal, beforeCommit: async index => { if (index === 1) partial.abort(); },
  });
  expect(result.status).toBe("partial"); expect(result.committed).toHaveLength(1);
});

test("move source deletion failure reports destination committed (no pretend rollback)", async () => {
  const root = await fixture({ a: "old" });
  const result = await executePatch(root, patch("*** Update File: a\n*** Move to: b"), {
    beforeCommit: async index => { if (index === 1) throw new Error("injected I/O failure"); },
  });
  expect(result.status).toBe("partial"); expect(result.committed[0]?.path).toBe("b");
  expect(await fs.readFile(join(root, "a"), "utf8")).toBe("old");
  expect(await fs.readFile(join(root, "b"), "utf8")).toBe("old");
});

test("queue interoperates with built-in edit and overlapping batches do not deadlock", async () => {
  const root = await fixture({ a: "old", b: "old" });
  let unlock!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const hold = withFileMutationQueue(join(root, "a"), async () => {
    entered(); await new Promise<void>(resolve => unlock = resolve);
    await fs.writeFile(join(root, "a"), "changed");
  });
  await ready;
  const running = executePatch(root, patch(update("a", "changed", "patched")));
  unlock(); await hold;
  expect((await running).status).toBe("applied");
  const edit = createEditTool(root);
  await edit.execute("id", { path: "a", edits: [{ oldText: "patched", newText: "old" }] });
  const both = await Promise.all([
    executePatch(root, patch(`${update("a")}\n${update("b")}`)),
    executePatch(root, patch(`${update("b")}\n${update("a")}`)),
  ]);
  expect(both.map(r => r.status).sort()).toEqual(["applied", "rejected"]);
}, 10000);

test("large reports are bounded and matching fallbacks are visible", async () => {
  const root = await fixture({ a: "old  \n", big: "a".repeat(150000) });
  const result = await executePatch(root, patch(`${update("a")}\n*** Delete File: big`));
  expect(result.status).toBe("applied"); expect(result.warnings[0]).toContain("trailing whitespace");
  expect(result.diff).toContain("diff omitted"); expect(Buffer.byteLength(result.diff)).toBeLessThan(25 * 1024);
});
