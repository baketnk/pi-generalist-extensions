import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import evidence from "../extensions/evidence.ts";
import { EvidenceStore, FILE_BYTES, EXCERPT_BYTES } from "../lib/evidence/store.ts";
import { EvidenceView, safeText } from "../lib/evidence/view.ts";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "evidence-test-")), root = join(dir, "shelf"), path = join(dir, "source.ts");
  writeFileSync(path, "// contract\nconst answer = 42;\n// 日本語\n");
  const store = new EvidenceStore(root, dir);
  const input = { id: "e1", title: "Answer is initialized here", kind: "source-observation" as const, path: "source.ts", start: 2, end: 3 };
  return { dir, root, path, store, input, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function harness(f: ReturnType<typeof fixture>) {
  const tools: any = {}, commands: any = {}, notices: string[] = [];
  evidence({ registerTool(t: any) { tools[t.name] = t; }, registerCommand(n: string, c: any) { commands[n] = c; } } as any, () => f.root);
  const ctx: any = { cwd: f.dir, mode: "tui", hasUI: true, waitForIdle: async () => {},
    ui: { notify: (text: string) => notices.push(text), select: async () => undefined, input: async () => undefined } };
  const call = async (params: any, signal?: AbortSignal) => JSON.parse((await tools.evidence.execute("call", params, signal, undefined, ctx)).content[0].text);
  return { tools, commands, notices, ctx, call, command: (args: string) => commands.evidence.handler(args, ctx) };
}

test("lazy registration/listing, immutable captured bytes and no source mutation", () => {
  const f = fixture();
  try {
    harness(f); expect(existsSync(f.root)).toBe(false);
    expect(f.store.list()).toEqual([]); expect(existsSync(f.root)).toBe(false);
    const original = readFileSync(f.path), e = f.store.capture(f.input);
    expect(e.excerpt).toBe("const answer = 42;\n// 日本語");
    expect(e.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(f.path)).toEqual(original);
    expect(new EvidenceStore(f.root, f.dir).read("e1")).toEqual(e);
    expect(() => f.store.capture({ ...f.input, title: "replace" })).toThrow("already exists");
    expect(f.store.read("e1")).toEqual(e);
    expect(readdirSync(f.store.directory)).toEqual(["e1.json"]);
    expect(f.store.list()[0]!.freshness).toBe("not checked");
  } finally { f.clean(); }
});

test("whole-file freshness differs from excerpt identity, and checks never rewrite evidence", () => {
  const f = fixture();
  try {
    const e = f.store.capture(f.input), recordPath = join(f.store.directory, "e1.json"), saved = readFileSync(recordPath);
    expect(f.store.check("e1").status).toBe("unchanged");
    writeFileSync(f.path, "// CHANGED elsewhere\nconst answer = 42;\n// 日本語\n");
    const changed = f.store.check("e1", true);
    expect(changed.status).toBe("changed"); expect(changed.currentExcerpt).toBe(e.excerpt);
    expect(changed.meaning).toContain("not proof");
    writeFileSync(f.path, "one line");
    expect(f.store.check("e1", true).currentRange).toContain("no longer exists");
    rmSync(f.path);
    expect(f.store.check("e1").status).toBe("missing");
    expect(f.store.read("e1")).toEqual(e);
    expect(readFileSync(recordPath)).toEqual(saved);
  } finally { f.clean(); }
});

test("test-contract kind never claims execution; changed comparisons stay positional", () => {
  const f = fixture();
  try {
    const e = f.store.capture({ ...f.input, kind: "test-contract-inspected" });
    writeFileSync(f.path, "// added line\n// contract\nconst answer = 42;\n// 日本語\n");
    const c = f.store.check("e1", true);
    expect(e.kind).toBe("test-contract-inspected");
    expect(c.currentExcerpt).toBe("// contract\nconst answer = 42;");
    expect(c.currentRange).toContain("not symbol relocation");
    expect(c).not.toHaveProperty("passed");
  } finally { f.clean(); }
});

test("limits, malformed IDs/ranges, binary and invalid UTF-8 reject without publication", () => {
  const f = fixture();
  try {
    for (const id of ["", "../x", "E1", "x".repeat(65)]) expect(() => f.store.capture({ ...f.input, id })).toThrow();
    for (const [start, end] of [[0, 1], [3, 2], [1, 161], [1, 999], [1.5, 2]])
      expect(() => f.store.capture({ ...f.input, start: start!, end: end! })).toThrow();
    expect(() => f.store.capture({ ...f.input, title: " " })).toThrow();
    expect(() => f.store.capture({ ...f.input, title: "明".repeat(81) })).toThrow();
    for (const data of [Buffer.from([0xff]), Buffer.from("x\0y"), Buffer.alloc(FILE_BYTES + 1, 97)]) {
      writeFileSync(f.path, data); expect(() => f.store.capture({ ...f.input, start: 1, end: 1 })).toThrow();
    }
    writeFileSync(f.path, "明".repeat(Math.ceil(EXCERPT_BYTES / 3) + 1));
    expect(() => f.store.capture({ ...f.input, start: 1, end: 1 })).toThrow("Excerpt exceeds");
    expect(existsSync(f.root)).toBe(false);
  } finally { f.clean(); }
});

test("serialized record and combined-output limits fail explicitly without truncation", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "\u0001".repeat(6000));
    expect(() => f.store.capture({ ...f.input, start: 1, end: 1 })).toThrow("Serialized evidence");
    expect(existsSync(f.root)).toBe(false);
    writeFileSync(f.path, "\t".repeat(EXCERPT_BYTES));
    f.store.capture({ ...f.input, start: 1, end: 1 });
    writeFileSync(f.path, "\r".repeat(EXCERPT_BYTES));
    const h = harness(f);
    await expect(h.call({ action: "compare", id: "e1" })).rejects.toThrow("48 KiB");
    expect((await h.call({ action: "read", id: "e1" })).excerpt.length).toBe(EXCERPT_BYTES);
    expect((await h.call({ action: "check", id: "e1" })).status).toBe("changed");
  } finally { f.clean(); }
});

test("project boundaries and storage symlinks fail closed; missing source is not permission to escape", () => {
  const f = fixture(), other = fixture();
  try {
    expect(() => f.store.capture({ ...f.input, path: other.path })).toThrow("inside");
    symlinkSync(other.path, join(f.dir, "escape"));
    expect(() => f.store.capture({ ...f.input, path: "escape" })).toThrow("outside");
    symlinkSync(f.path, join(f.dir, "inside"));
    const e = f.store.capture({ ...f.input, path: "inside" });
    expect(e.source).toBe("source.ts"); // follows canonical target, not alias
    rmSync(f.path); symlinkSync(other.path, f.path);
    expect(f.store.check("e1").status).toBe("unavailable");
    expect(f.store.read("e1")).toEqual(e);
    const record = join(f.store.directory, "e1.json"); rmSync(record); symlinkSync(other.path, record);
    expect(() => f.store.read("e1")).toThrow();
    rmSync(f.root, { recursive: true }); symlinkSync(other.dir, f.root);
    expect(() => f.store.list()).toThrow("real directory");
  } finally { f.clean(); other.clean(); }
});

test("corrupt records and oversized current comparisons are explicit, never fallback evidence", () => {
  const f = fixture();
  try {
    f.store.capture(f.input);
    writeFileSync(f.path, "x\n" + "y".repeat(EXCERPT_BYTES + 1));
    const c = f.store.check("e1", true);
    expect(c.status).toBe("changed"); expect(c.error).toContain("Excerpt exceeds");
    expect(c.currentExcerpt).toBeUndefined();
    writeFileSync(join(f.store.directory, "e1.json"), '{"version":2}');
    expect(() => f.store.read("e1")).toThrow("Invalid evidence");
  } finally { f.clean(); }
});

test("two independent publishers cannot overwrite the same evidence ID", async () => {
  const f = fixture();
  try {
    const module = resolve(import.meta.dir, "../lib/evidence/store.ts");
    const script = `import {EvidenceStore} from ${JSON.stringify(module)};try {new EvidenceStore(${JSON.stringify(f.root)},${JSON.stringify(f.dir)}).capture(${JSON.stringify(f.input)});process.exit(0);}catch(e){process.exit(String(e).includes('already exists')?2:3);}`;
    const processes = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
    expect((await Promise.all(processes.map(p => p.exited))).sort()).toEqual([0, 2]);
    expect(f.store.read("e1").excerpt).toContain("answer");
  } finally { f.clean(); }
});

test("tools execute on demand with bounded pagination and cancellation, without hooks", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    await expect(h.call({ action: "capture", id: "e1" })).rejects.toThrow("requires");
    const controller = new AbortController(); controller.abort();
    await expect(h.call({ action: "capture", ...f.input }, controller.signal)).rejects.toThrow();
    expect(existsSync(f.root)).toBe(false);
    for (let i = 0; i < 21; i++) await h.call({ action: "capture", ...f.input, id: `e${String(i).padStart(2, "0")}` });
    const first = await h.call({ action: "list" });
    expect(first.records).toHaveLength(20); expect(first.nextOffset).toBe(20);
    expect((await h.call({ action: "list", offset: 20 })).records).toHaveLength(1);
    expect((await h.call({ action: "read", id: "e00" })).excerpt).toContain("answer");
    expect((await h.call({ action: "check", id: "e00" })).status).toBe("unchanged");
    expect((await h.call({ action: "compare", id: "e00" })).current.currentExcerpt).toContain("answer");
    expect(h.tools.evidence.description).toContain("not truth");
  } finally { f.clean(); }
});

test("human capture cancels without writes; picker/check/compare never start a model", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    await h.command("capture"); expect(existsSync(f.root)).toBe(false);
    const inputs = ["e1", "An observation", "source.ts", "2-3"];
    h.ctx.ui.input = async () => inputs.shift();
    h.ctx.ui.select = async () => "source-observation";
    await h.command("capture"); expect(f.store.read("e1").kind).toBe("source-observation");
    await h.command("check e1"); expect(h.notices.at(-1)).toContain("unchanged");
    const theme: any = { fg: (_: string, text: string) => text };
    const keys: any = { getKeys: () => ["esc"], matches: () => false };
    let shown = "";
    h.ctx.ui.custom = async (factory: Function) => {
      const view = factory({ terminal: { rows: 100 }, requestRender() {} }, theme, keys, () => {});
      shown = view.render(160).join("\n");
    };
    await h.command("compare e1");
    expect(shown).toContain("CAPTURED EXCERPT"); expect(shown).toContain("CURRENT SOURCE — unchanged");
    h.ctx.ui.select = async (_title: string, choices: string[]) => choices[0];
    await h.command(""); expect(shown).toContain("CAPTURED EXCERPT");
    await h.command("nonsense"); expect(h.notices.at(-1)).toContain("Usage:");
    h.ctx.mode = "rpc"; await h.command("read e1"); expect(h.notices.at(-1)).toContain("requires TUI");
  } finally { f.clean(); }
});

test("viewer scrolls/resizes and neutralizes terminal controls", () => {
  const theme: any = { fg: (_: string, text: string) => text };
  const keys: any = { getKeys: (action: string) => [action.split(".").pop()], matches: (data: string, action: string) => data === action.split(".").pop() };
  let rows = 24, closed = false;
  const view = new EvidenceView("Evidence", Array.from({ length: 160 }, (_, i) => `${i} 日本語`).join("\n"), theme, keys, () => rows, () => {}, () => closed = true);
  view.render(100); view.handleInput("pageDown"); expect(view.render(100).join("\n")).not.toContain("\n0 日本語");
  for (const width of [1, 10, 40, 100]) {
    rows = width < 10 ? 3 : 24;
    const lines = view.render(width);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * .8)));
  }
  expect(safeText("\x1b]52;c;secret\x07safe\x1b[31mtext")).toBe("safetext");
  view.handleInput("cancel"); expect(closed).toBe(true);
});
