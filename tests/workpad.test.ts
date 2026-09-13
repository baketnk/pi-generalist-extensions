import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import workpad, { ATTACHMENT, CONTEXT } from "../extensions/workpad.ts";
import { WorkpadStore, PAGE_BYTES } from "../lib/workpad/store.ts";
import { WorkpadView, plain } from "../lib/workpad/view.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workpad-test-"));
  const root = join(dir, "pads"), store = new WorkpadStore(root, dir);
  return { dir, root, store, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function harness(f: ReturnType<typeof fixture>, entries: any[] = [], manager?: SessionManager) {
  const events: Record<string, Function> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {};
  const notices: string[] = [];
  const pi: any = { on: (n: string, fn: Function) => events[n] = fn,
    registerTool: (t: any) => tools[t.name] = t, registerCommand: (n: string, c: any) => commands[n] = c,
    appendEntry: (customType: string, data: any) => manager ? manager.appendCustomEntry(customType, data) : entries.push({ type: "custom", customType, data }),
  };
  const ctx: any = { cwd: f.dir, hasUI: true, mode: "tui", model: { contextWindow: 10000 }, waitForIdle: async () => {},
    sessionManager: manager ?? { getSessionId: () => "session-a", getBranch: () => entries },
    ui: { setStatus() {}, notify: (text: string) => notices.push(text), editor: async () => undefined, select: async () => undefined },
  };
  workpad(pi, () => f.root);
  const call = async (params: any, signal?: AbortSignal) => JSON.parse((await tools.workpad.execute("id", params, signal, undefined, ctx)).content[0].text);
  const request = (messages: any[] = []) => events.context!({ messages }, ctx).messages as any[];
  const command = (args: string) => commands.workpad.handler(args, ctx);
  return { events, tools, commands, entries, notices, ctx, call, request, command };
}
const user = (content: string, timestamp = 1) => ({ role: "user", content, timestamp });
const encoded = (messages: any[]) => convertToLlm(messages).map(m => JSON.stringify(m)).join("\n");
const snapshots = (messages: any[]) => messages.filter(m => m.customType === CONTEXT);

test("storage is lazy; immutable revisions survive reopening and reject stale writers", () => {
  const f = fixture();
  try {
    expect(f.store.list()).toEqual([]); expect(existsSync(f.root)).toBe(false);
    const page = f.store.create("design", "# Design\nMaybe.");
    expect(page.revision).toBe(1); expect(page.path.endsWith("00000001.md")).toBe(true);
    expect(() => f.store.create("design", "another")).toThrow("conflict");
    f.store.update("design", 1, "# Design\nCorrected.");
    const reopened = new WorkpadStore(f.root, f.dir);
    expect(reopened.read("design").content).toContain("Corrected");
    expect(reopened.read("design", 1).content).toContain("Maybe");
    expect(reopened.list()).toEqual([{ id: "design", revision: 2, title: "Design" }]);
    expect(() => reopened.update("design", 1, "stale")).toThrow("conflict");
    expect(readdirSync(join(f.store.directory, "design"))).toHaveLength(2);
  } finally { f.clean(); }
});

test("2/4/8 KiB write caps count UTF-8 bytes; historical 8 KiB reads remain available", () => {
  const f = fixture();
  try {
    expect(f.store.maxBytes).toBe(4096);
    for (const cap of [2048, 4096, 8192]) {
      const s = new WorkpadStore(f.root, f.dir, cap), id = `cap-${cap}`;
      s.create(id, "x".repeat(cap));
      expect(() => s.update(id, 1, "x".repeat(cap + 1))).toThrow("bytes");
      expect(s.read(id).revision).toBe(1);
    }
    expect(f.store.read("cap-8192").content.length).toBe(PAGE_BYTES);
    expect(() => f.store.create("unicode", "明".repeat(1400))).toThrow("bytes");
    expect(() => new WorkpadStore(f.root, f.dir, 123)).toThrow();
    for (const id of ["../escape", "A", "", "a/b", "a".repeat(65)]) expect(() => f.store.create(id, "text")).toThrow();
    expect(() => f.store.create("empty", " ")).toThrow("empty");
    expect(() => f.store.update("cap-2048", 0, "x")).toThrow();
    expect(() => f.store.read("cap-2048", 999999999)).toThrow();
    const other = join(f.dir, "outside.md"); writeFileSync(other, "outside");
    symlinkSync(other, join(f.store.directory, "cap-2048", "00000002.md"));
    expect(() => f.store.read("cap-2048")).toThrow();
    symlinkSync(f.dir, join(f.store.directory, "alias"));
    expect(() => f.store.create("alias", "bad")).toThrow("directory");
  } finally { f.clean(); }
});

test("independent writers cannot both publish the same successor", async () => {
  const f = fixture();
  try {
    f.store.create("shared", "initial");
    const module = resolve(import.meta.dir, "../lib/workpad/store.ts");
    const script = `import {WorkpadStore} from ${JSON.stringify(module)}; const s = new WorkpadStore(${JSON.stringify(f.root)},${JSON.stringify(f.dir)}); try {s.update('shared',1,'winner'); process.exit(0);} catch(e) {process.exit(String(e).includes('conflict')?2:3);}`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
    expect((await Promise.all(children.map(c => c.exited))).sort()).toEqual([0, 2]);
    expect(f.store.read("shared").revision).toBe(2);
  } finally { f.clean(); }
});

test("startup is inert; create doesn't attach; writes require attachment/revision and honor cancellation", async () => {
  const f = fixture();
  try {
    const h = harness(f); h.events.session_start!({}, h.ctx);
    expect(existsSync(f.root)).toBe(false); expect(h.request([user("A")])).toEqual([user("A")]);
    await h.call({ action: "create", id: "task", content: "# Tentative" });
    expect(h.entries).toHaveLength(0);
    await expect(h.call({ action: "update", expectedRevision: 1, content: "bad" })).rejects.toThrow("No workpad");
    await h.call({ action: "attach", id: "task" });
    expect(h.entries[0].customType).toBe(ATTACHMENT);
    await expect(h.call({ action: "update", id: "other", expectedRevision: 1, content: "bad" })).rejects.toThrow("attached");
    await h.call({ action: "update", expectedRevision: 1, content: "# Corrected" });
    expect((await h.call({ action: "read" })).revision).toBe(2);
    expect((await h.call({ action: "read", revision: 1 })).content).toBe("# Tentative");
    const controller = new AbortController(); controller.abort();
    await expect(h.call({ action: "update", expectedRevision: 2, content: "abort" }, controller.signal)).rejects.toThrow();
    expect(f.store.read("task").revision).toBe(2);
  } finally { f.clean(); }
});

test("[A B W1 C D W2] is append-only across edits, tool follow-ups, retries and reload", async () => {
  const f = fixture();
  try {
    const h = harness(f); f.store.create("task", "# Original");
    await h.call({ action: "attach", id: "task" });
    const base: any[] = [user("A".repeat(100000)), user("B", 2)];
    const first = h.request(base), prefix = encoded(first);
    expect(base).toHaveLength(2); expect(first).toHaveLength(3);
    expect(first.at(-1).content).toContain("not a user request");
    expect(convertToLlm(first).at(-1)!.role).toBe("user");
    expect(h.request(base)).toEqual(first); // no duplicate on retry
    expect(h.request(first)).toEqual(first); // projection fed back
    const assistant: any = { role: "assistant", content: [
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
    ], timestamp: 3 };
    const results = ["a", "b"].map(id => ({ role: "toolResult", toolCallId: `call-${id}`, toolName: "read",
      content: [{ type: "text", text: id }], isError: false, timestamp: 4 }));
    const longer = [...base, assistant, ...results];
    const unchanged = h.request(longer);
    expect(encoded(unchanged).startsWith(prefix + "\n")).toBe(true);
    expect(snapshots(unchanged)).toHaveLength(1); // no moving tail, no per-request repeat
    f.store.update("task", 1, "# Corrected");
    const changed = h.request(longer);
    expect(encoded(changed).startsWith(encoded(unchanged) + "\n")).toBe(true);
    expect(changed.slice(-3).map(m => m.role)).toEqual(["toolResult", "toolResult", "custom"]);
    expect(changed.at(-1).content).toContain("revision 2");
    expect(changed.at(-1).content).toContain("supersedes");
    expect(snapshots(changed)[0]).toEqual(first.at(-1));
    const restarted = harness(f, JSON.parse(JSON.stringify(h.entries)));
    expect(restarted.request(longer)).toEqual(changed);
    expect(restarted.request([...changed, user("E", 5)]).slice(0, -1)).toEqual(changed);
    const foreign = { role: "custom", customType: "unrelated", content: "Keep", display: false, timestamp: 6 };
    expect(h.request([...longer, foreign])).toContainEqual(foreign);
    expect(snapshots(h.request([...base, assistant, ...results]))).toHaveLength(2);
  } finally { f.clean(); }
});

test("external context trimming resets projection without resurrecting stale later snapshots", async () => {
  const f = fixture();
  try {
    const h = harness(f); f.store.create("task", "# One");
    await h.call({ action: "attach", id: "task" });
    const base = [user("A")], longer = [...base, user("B", 2)];
    h.request(base);
    f.store.update("task", 1, "# Two"); h.request(longer);
    f.store.update("task", 2, "# Three");
    const trimmed = h.request(base);
    expect(snapshots(trimmed)).toHaveLength(1);
    expect(trimmed.at(-1).content).toContain("revision 3");
    const restored = h.request(longer);
    expect(encoded(restored).startsWith(encoded(trimmed) + "\n")).toBe(true);
    expect(snapshots(restored)).toHaveLength(1);
    expect(encoded(restored)).not.toContain("revision 2");
  } finally { f.clean(); }
});

test("real SessionManager journals replay across compaction and fresh extension instances", async () => {
  const f = fixture();
  try {
    const manager = SessionManager.create(f.dir, join(f.dir, "sessions")), h = harness(f, [], manager);
    f.store.create("task", "# Initial");
    await h.call({ action: "attach", id: "task" });
    const firstId = manager.appendMessage(user("A") as any);
    const first = h.request(manager.buildSessionContext().messages);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "C" }],
      api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 2, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    manager.appendMessage(user("B", 3) as any);
    f.store.update("task", 1, "# Revised");
    const second = h.request(manager.buildSessionContext().messages);
    expect(encoded(second).startsWith(encoded(first) + "\n")).toBe(true);
    expect(snapshots(second)).toHaveLength(2);
    expect(manager.buildSessionContext().messages).toHaveLength(3); // journal entries aren't ordinary messages
    const restored = SessionManager.open(manager.getSessionFile()!);
    const reloaded = harness(f, [], restored);
    expect(reloaded.request(restored.buildSessionContext().messages)).toEqual(second);
    restored.appendCompaction("Summary", firstId, 10000);
    const compacted = reloaded.request(restored.buildSessionContext().messages);
    expect(snapshots(compacted)).toHaveLength(1);
    expect(compacted.at(-1).content).toContain("Revised");
    expect(reloaded.request(restored.buildSessionContext().messages)).toEqual(compacted);
    restored.branch(firstId); // before any published snapshot, but attachment exists
    expect(snapshots(reloaded.request(restored.buildSessionContext().messages))).toHaveLength(1);
  } finally { f.clean(); }
});

test("off/unavailable states append once, recovery supersedes, compaction restores only current state", async () => {
  const f = fixture();
  try {
    const h = harness(f); f.store.create("task", "# Notes");
    await h.call({ action: "attach", id: "task" });
    const base = [user("A")], first = h.request(base);
    rmSync(join(f.store.directory, "task"), { recursive: true });
    const missing = h.request(base);
    expect(missing.slice(0, first.length)).toEqual(first); expect(missing.at(-1).content).toContain("unavailable");
    expect(h.request(base)).toEqual(missing);
    f.store.create("task", "# Restored");
    expect(h.request(base).at(-1).content).toContain("Restored");
    await h.call({ action: "detach" });
    const off = h.request(base); expect(off.at(-1).content).toContain("inactive");
    expect(h.request(base)).toEqual(off);
    h.entries.push({ type: "compaction", id: "compact-a", summary: "old notes" });
    const compacted = [{ role: "compactionSummary", summary: "old notes", tokensBefore: 10000, timestamp: 10 }];
    const compactOff = h.request(compacted);
    expect(snapshots(compactOff)).toHaveLength(1); expect(compactOff.at(-1).content).toContain("inactive");
    await h.call({ action: "attach", id: "task" });
    const active = h.request(compacted); expect(active.at(-1).content).toContain("Restored");
    h.entries.push({ type: "compaction", id: "compact-b", summary: "summary" });
    expect(snapshots(h.request(compacted))).toHaveLength(1);
    expect(h.request(compacted).at(-1).content).toContain("Restored");
    // Branch back before compaction: the old anchored history is unchanged.
    h.entries.splice(h.entries.findIndex(e => e.id === "compact-a"));
    expect(h.request(base)).toEqual(off);
  } finally { f.clean(); }
});

test("forks/projects start detached and mark inherited snapshots historical", async () => {
  const f = fixture(), other = fixture();
  try {
    const h = harness(f); f.store.create("task", "# Parent");
    await h.call({ action: "attach", id: "task" });
    const base = [user("A")], parent = h.request(base);
    h.ctx.sessionManager.getSessionId = () => "fork";
    const fork = h.request(base); expect(fork.slice(0, parent.length)).toEqual(parent);
    expect(fork.at(-1).content).toContain("inactive");
    expect((await h.call({ action: "list" })).attached).toBeNull();
    h.ctx.cwd = other.dir;
    expect((await h.call({ action: "list" })).attached).toBeNull();
    expect(h.request(base).at(-1).content).toContain("inactive");
  } finally { f.clean(); other.clean(); }
});

test("session-scoped caps and optional percentage reminders persist; reminders retain revision", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    await h.command("size 2");
    await expect(h.call({ action: "create", id: "big", content: "x".repeat(2049) })).rejects.toThrow("bytes");
    await h.command("size 8");
    await h.call({ action: "create", id: "big", content: "x".repeat(5000) });
    await h.call({ action: "attach", id: "big" });
    await h.command("size 4"); expect(h.notices.at(-1)).toContain("bytes");
    expect((await h.call({ action: "list" })).settings.pageBytes).toBe(8192);
    const base = [user("A")]; h.request(base);
    const longer = [...base, user("x".repeat(8000), 2)];
    expect(snapshots(h.request(longer))).toHaveLength(1); // refresh off by default
    await h.command("refresh 10");
    const reminded = h.request(longer);
    expect(snapshots(reminded)).toHaveLength(2);
    expect(reminded.at(-1).content).toContain("reminder (same revision)");
    expect(reminded.at(-1).content).toContain("revision 1");
    expect(h.request(longer)).toEqual(reminded);
    const reload = harness(f, JSON.parse(JSON.stringify(h.entries)));
    expect((await reload.call({ action: "list" })).settings).toEqual({ pageBytes: 8192, refreshPercent: 10 });
    expect(reload.request(longer)).toEqual(reminded);
    await h.command("refresh off");
    expect(snapshots(h.request([...longer, user("x".repeat(8000), 3)]))).toHaveLength(2);
    for (const invalid of ["size 3", "refresh 0", "refresh 101", "refresh NaN", "refresh 1.5"]) {
      await h.command(invalid); expect(h.notices.at(-1)).toMatch(/must be/);
    }
    h.ctx.sessionManager.getSessionId = () => "new-session";
    expect((await h.call({ action: "list" })).settings).toEqual({ pageBytes: 4096, refreshPercent: 0 });
  } finally { f.clean(); }
});

test("legacy oversized attachments fail explicitly, remain readable, and recover with larger cap", async () => {
  const f = fixture();
  try {
    new WorkpadStore(f.root, f.dir, 8192).create("legacy", "x".repeat(5000));
    const h = harness(f);
    await expect(h.call({ action: "attach", id: "legacy" })).rejects.toThrow("bytes");
    h.entries.push({ type: "custom", customType: ATTACHMENT, data: { project: f.store.project, session: "session-a", id: "legacy" } });
    expect(h.request().at(-1).content).toContain("unavailable");
    expect((await h.call({ action: "read" })).content.length).toBe(5000);
    await h.command("size 8");
    expect(h.request().at(-1).content).toContain("revision 1");
  } finally { f.clean(); }
});

test("commands cancel safely, recover conflict drafts, and viewer fits narrow terminals", async () => {
  const f = fixture();
  try {
    const h = harness(f); await h.command("new draft"); expect(existsSync(f.root)).toBe(false);
    h.ctx.ui.editor = async () => "# User draft";
    await h.command("new draft"); expect(h.entries).toHaveLength(1);
    let editors = 0;
    h.ctx.ui.editor = async (title: string, initial: string) => {
      if (++editors === 1) { f.store.update("draft", 1, "# Concurrent"); return "# Unsaved"; }
      expect(title).toContain("NOT SAVED"); expect(initial).toBe("# Unsaved"); return undefined;
    };
    await h.command("edit"); expect(editors).toBe(2); expect(h.notices.at(-1)).toContain("conflict");
    await h.command("off"); expect(h.entries.at(-1).data.id).toBeNull();
    await h.command("attach draft"); expect(h.entries.at(-1).data.id).toBe("draft");
    await h.command("nonsense"); expect(h.notices.at(-1)).toContain("Usage:");
    h.ctx.mode = "rpc"; await h.command(""); expect(h.notices.at(-1)).toContain("requires TUI");
    const theme: any = { fg: (_color: string, text: string) => text };
    const keys: any = { matches: (data: string, action: string) => data === action.split(".").pop(), getKeys: (action: string) => [action.split(".").pop()] };
    let rows = 24, closed = false;
    const page = { id: "task", revision: 3, path: "fixture", content: Array.from({ length: 80 }, (_, i) => `${i} 日本語`).join("\n") };
    const view = new WorkpadView(page, theme, keys, () => rows, () => {}, () => closed = true);
    expect(view.render(100).join("\n")).toContain("revision 3");
    view.handleInput("pageDown"); expect(view.render(100).join("\n")).not.toContain("\n0 日本語");
    for (const width of [1, 10, 40, 100]) {
      rows = width < 10 ? 3 : 24;
      const lines = view.render(width);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
    }
    expect(plain("\x1b]52;c;secret\x07safe\x1b[31mtext")).toBe("safetext");
    view.handleInput("cancel"); expect(closed).toBe(true);
  } finally { f.clean(); }
});
