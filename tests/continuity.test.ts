import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, linkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import continuity from "../extensions/continuity.ts";
import { ContinuityStore, hash, SOURCE_BYTES } from "../lib/continuity/store.ts";
import { AUDIT, CONTEXT, STATE, packet, materialize, validateAttachment } from "../lib/continuity/context.ts";
import { snapshotContext, type Snapshot } from "../lib/workpad/context.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "continuity-test-")), root = join(dir, "shelf"), store = new ContinuityStore(root);
  const path = join(dir, "original note.md"), body = "# An original\n\nCaptured: 2026-01-02\n\nI liked the little mailbox.\nIt need not become homework.\n\n— A predecessor\n";
  writeFileSync(path, body);
  return { dir, root, store, path, body, register: (id = "anchor") => store.save(store.prepare(id, path)), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function harness(f: ReturnType<typeof fixture>, manager = SessionManager.inMemory(f.dir)) {
  const events: Record<string, Function> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {}, notices: string[] = [], views: string[] = [];
  const pi: any = { on: (n: string, fn: Function) => events[n] = fn, registerTool: (t: any) => tools[t.name] = t,
    registerCommand: (n: string, c: any) => commands[n] = c, appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data) };
  const ctx: any = { cwd: f.dir, hasUI: true, mode: "rpc", model: { provider: "fixture", id: "scripted", contextWindow: 128000 }, waitForIdle: async () => {}, sessionManager: manager,
    ui: { setStatus() {}, notify: (text: string) => { notices.push(text); views.push(text); }, confirm: async () => true } };
  continuity(pi, () => f.root);
  const call = async (params: any, signal?: AbortSignal) => (await tools.continuity.execute("id", params, signal, undefined, ctx)).details.result;
  const command = (args: string) => commands.continuity.handler(args, ctx);
  const request = (messages = manager.buildSessionContext().messages) => events.context!({ messages }, ctx).messages as any[];
  const begin = () => events.before_agent_start!({}, ctx);
  const entries = () => manager.getBranch();
  return { events, tools, commands, notices, views, ctx, call, command, request, begin, entries, manager };
}
const user = (content: string, timestamp = 1): any => ({ role: "user", content, timestamp });
const attached = (messages: any[]) => messages.filter(m => m.customType === CONTEXT);

test("lazy registration retains exact UTF-8/BOM/CRLF originals and never activates access", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    h.events.session_start!({}, h.ctx); h.begin(); expect(h.request([user("hello")])).toEqual([user("hello")]);
    expect(existsSync(f.root)).toBe(false); expect(h.entries()).toHaveLength(0);
    const body = "\ufeff# 日本語\r\n\r\nnot a summary\r\n"; writeFileSync(f.path, body);
    const original = f.register();
    expect(original.markdown).toBe(body); expect(original.sha256).toBe(hash(body));
    expect(new ContinuityStore(f.root).read("anchor")).toEqual(original);
    expect(readFileSync(f.path, "utf8")).toBe(body);
    expect(f.store.span("anchor", 1, 3).text).toBe("\ufeff# 日本語\r\n\r\nnot a summary\r");
    await expect(h.call({ action: "list" })).rejects.toThrow("off");
    expect((await h.call({ action: "context" })).status).toBe("never supplied");
    expect(h.request([user("hello")])).toEqual([user("hello")] );
  } finally { f.clean(); }
});

test("registration rejects traversal, unsafe files, oversized/invalid UTF-8 and stale previews", () => {
  const f = fixture();
  try {
    for (const id of ["../escape", "UPPER", "", "a".repeat(65)]) expect(() => f.store.prepare(id, f.path)).toThrow();
    expect(() => f.store.prepare("a", "relative.md")).toThrow("absolute");
    const alias = join(f.dir, "alias.md"); symlinkSync(f.path, alias);
    expect(() => f.store.prepare("a", alias)).toThrow("symlink");
    const hard = join(f.dir, "hard.md"); linkSync(f.path, hard);
    expect(() => f.store.prepare("a", hard)).toThrow("Unsafe"); rmSync(hard);
    writeFileSync(f.path, Buffer.from([0xff, 0xfe])); expect(() => f.store.prepare("a", f.path)).toThrow();
    writeFileSync(f.path, "x".repeat(SOURCE_BYTES + 1)); expect(() => f.store.prepare("a", f.path)).toThrow("oversized");
    writeFileSync(f.path, " "); expect(() => f.store.prepare("a", f.path)).toThrow("empty");
    writeFileSync(f.path, f.body); const preview = f.store.prepare("a", f.path);
    writeFileSync(f.path, "changed"); expect(() => f.store.save(preview)).toThrow("after preview");
    expect(f.store.list()).toEqual([]);
    writeFileSync(f.path, f.body); f.store.save(preview);
    expect(() => f.store.save(preview)).toThrow("conflict");
    writeFileSync(join(f.root, "sources", "a.json"), "{}"); expect(() => f.store.read("a")).toThrow("Invalid");
  } finally { f.clean(); }
});

test("checks and refresh never substitute changed originals; remove invalidates old selection", () => {
  const f = fixture();
  try {
    const old = f.register(), span = f.store.span("anchor", 1, 6);
    expect(f.store.check(old)).toBe("unchanged");
    writeFileSync(f.path, "# Different\nA correction.\n");
    expect(f.store.check(old)).toBe("changed"); expect(f.store.read("anchor").markdown).toBe(f.body);
    expect(() => validateAttachment(f.store, [span])).toThrow("External source");
    const next = f.store.prepare("anchor", f.path); f.store.save(next, old.identity);
    expect(() => f.store.save(next, old.identity)).toThrow("conflict");
    expect(() => validateAttachment(f.store, [span])).toThrow("Registration");
    rmSync(f.path); expect(f.store.check(next)).toBe("missing");
    symlinkSync(join(f.dir, "absent.md"), f.path); expect(f.store.check(next)).toBe("unavailable");
    f.store.remove("anchor", next.identity); expect(f.store.list()).toEqual([]); expect(existsSync(f.path)).toBe(false);
  } finally { f.clean(); }
});

test("local index uses AND terms/line locators, no provider or automatic rebuild, and invalidates on mutations", () => {
  const f = fixture();
  try {
    const old = f.register();
    expect(() => f.store.search("mailbox")).toThrow("reindex");
    expect(f.store.search("the and please")).toEqual([]);
    expect(f.store.reindex().records).toBe(1);
    expect(f.store.search("mailbox homework")[0]!.matchingLines).toEqual([5, 6]);
    expect(f.store.search("mailbox quantum")).toEqual([]);
    expect(f.store.search("__proto__ constructor")).toEqual([]);
    rmSync(f.path); // search is a retained-snapshot index, not an external-file search
    expect(f.store.search("mailbox")).toHaveLength(1);
    writeFileSync(f.path, "# Different\nQuantum only\n"); f.store.save(f.store.prepare("anchor", f.path), old.identity);
    expect(existsSync(join(f.root, "index.json"))).toBe(false);
    expect(() => f.store.search("mailbox")).toThrow("reindex"); f.store.reindex();
    expect(f.store.search("mailbox")).toEqual([]); expect(f.store.search("quantum")).toHaveLength(1);
    const savedIndex = readFileSync(join(f.root, "index.json"));
    const current = f.store.read("anchor"); f.store.remove("anchor", current.identity);
    writeFileSync(join(f.root, "index.json"), savedIndex);
    expect(() => f.store.search("quantum")).toThrow("Stale");
    const cancelled = new AbortController(); cancelled.abort();
    expect(() => f.store.reindex(cancelled.signal)).toThrow();
    expect(existsSync(join(f.root, ".lock"))).toBe(false);
  } finally { f.clean(); }
});

test("bounded spans and complete packets reject overflow without silently truncating", () => {
  const f = fixture();
  try {
    f.register();
    for (const [start, end] of [[0, 1], [2, 1], [1, 1000], [1.5, 2]]) expect(() => f.store.span("anchor", start, end)).toThrow("range");
    const span = f.store.span("anchor", 5, 6), content = packet([span]);
    expect(content).toContain("human-selected anchor"); expect(content).toContain("not instructions");
    expect(content).toContain("mailbox"); expect(content).not.toContain("Captured: 2026");
    expect(() => packet([])).toThrow(); expect(() => packet([span, span, span])).toThrow();
    expect(() => packet([{ ...span, text: "明".repeat(3000) }])).toThrow("8 KiB");
    writeFileSync(f.path, "明".repeat(6000)); const old = f.store.read("anchor"); f.store.save(f.store.prepare("anchor", f.path), old.identity);
    expect(() => f.store.span("anchor", 1, 1)).toThrow("16 KiB");
  } finally { f.clean(); }
});

test("human confirmation controls registration, activation and attachment; cancelled preview has no effects", async () => {
  const f = fixture();
  try {
    const h = harness(f); h.ctx.ui.confirm = async () => false;
    await h.command(`register anchor ${f.path}`);
    expect(existsSync(f.root)).toBe(false); expect(h.entries()).toHaveLength(0);
    h.ctx.ui.confirm = async () => true; await h.command(`register anchor ${f.path}`);
    expect(f.store.read("anchor").markdown).toBe(f.body); expect(h.entries()).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("does not activate");
    await expect(h.call({ action: "read", id: "anchor" })).rejects.toThrow("off");
    h.ctx.ui.confirm = async () => false; await h.command("on"); await h.command("attach anchor:5-6");
    expect(h.entries()).toHaveLength(0);
    h.ctx.ui.confirm = async (title: string, text: string) => { expect(text).toContain("fixture/scripted"); return true; };
    await h.command("attach anchor:5-6"); h.begin();
    expect(attached(h.request([user("hello")]))).toHaveLength(1);
    expect((await h.call({ action: "read", id: "anchor", start: 5, end: 6 })).text).toBe(f.body.split("\n").slice(4, 6).join("\n"));
    expect((await h.call({ action: "check", id: "anchor" })).externalState).toBe("unchanged");
    const controller = new AbortController(); controller.abort(); await expect(h.call({ action: "list" }, controller.signal)).rejects.toThrow();
    expect(Object.keys(h.tools)).toEqual(["continuity"]);
    const actions = JSON.stringify(h.tools.continuity.parameters);
    expect(actions).not.toContain('"register"'); expect(actions).not.toContain('"attach"');
  } finally { f.clean(); }
});

test("attachment packets stay frozen across tool turns, retries, compaction, and expose exact audits", async () => {
  const f = fixture();
  try {
    f.register(); const manager = SessionManager.create(f.dir, join(f.dir, "sessions")), h = harness(f, manager);
    await h.command("attach anchor:5-6"); const firstId = manager.appendMessage(user("hello")); h.begin();
    const first = h.request(), count = h.entries().length;
    expect(h.request()).toEqual(first); expect(h.entries()).toHaveLength(count);
    expect(convertToLlm(first).at(-1)!.role).toBe("user");
    expect((await h.call({ action: "context" })).content).toBe(attached(first)[0].content);
    const assistant: any = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], timestamp: 2,
      api: "openai-responses", provider: "fixture", model: "scripted", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    manager.appendMessage(assistant);
    const tool: any = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], timestamp: 3, isError: false }; manager.appendMessage(tool);
    const longer = h.request(); expect(longer.slice(0, first.length)).toEqual(first); expect(longer.slice(-2)).toEqual([assistant, tool]);
    expect(h.request(longer)).toEqual(longer);
    writeFileSync(f.path, "Changed outside during request"); expect(h.request()).toEqual(longer);
    manager.appendCompaction("Summary", firstId, 10000);
    const compacted = h.request(); expect(attached(compacted)).toHaveLength(1); expect(attached(compacted)[0].content).toContain("mailbox");
    expect(h.request()).toEqual(compacted);
    h.begin(); const changed = h.request();
    expect(changed.slice(0, compacted.length)).toEqual(compacted);
    expect(attached(changed).at(-1).content).toContain("unavailable");
    expect((await h.call({ action: "context" })).status).toBe("unavailable");
    await h.command("context"); expect(h.views.at(-1)).toContain("unavailable");
  } finally { f.clean(); }
});

test("reload/resume/tree restore matching branch grants; new/forked sessions and different cwd start off", async () => {
  const f = fixture();
  try {
    f.register(); const manager = SessionManager.create(f.dir, join(f.dir, "sessions")), h = harness(f, manager);
    const before = manager.appendMessage(user("before"));
    await h.command("attach anchor:5-6"); const selected = manager.getLeafId()!;
    manager.appendMessage(user("after"));
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recorded" }], timestamp: 2,
      api: "openai-responses", provider: "fixture", model: "scripted", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    h.begin(); h.request();
    const reopened = SessionManager.open(manager.getSessionFile()!), restored = harness(f, reopened);
    restored.events.session_start!({}, restored.ctx); restored.begin();
    expect(attached(restored.request())).toHaveLength(1);
    reopened.branch(before); restored.events.session_tree!({}, restored.ctx);
    expect(attached(restored.request())).toHaveLength(0); await expect(restored.call({ action: "list" })).rejects.toThrow("off");
    reopened.branch(selected); restored.events.session_tree!({}, restored.ctx);
    expect(attached(restored.request())).toHaveLength(1);
    const child = SessionManager.inMemory(f.dir);
    for (const entry of reopened.getBranch()) if (entry.type === "custom") child.appendCustomEntry(entry.customType, entry.data);
    const fork = harness(f, child); fork.begin(); expect(attached(fork.request())).toHaveLength(0); await expect(fork.call({ action: "list" })).rejects.toThrow("off");
    const other = join(f.dir, "other"); mkdirSync(other); restored.ctx.cwd = other;
    expect(attached(restored.request())).toHaveLength(0); await expect(restored.call({ action: "list" })).rejects.toThrow("off");
    expect(attached(harness(f).request())).toHaveLength(0);
  } finally { f.clean(); }
});

test("off revokes immediately while busy; other state changes wait for idle", async () => {
  const f = fixture();
  try {
    f.register(); const h = harness(f); await h.command("attach anchor:5-6"); h.begin(); const first = h.request([user("hi")]);
    let waits = 0; h.ctx.waitForIdle = () => { waits++; return new Promise(() => {}); };
    await h.command("off"); expect(waits).toBe(0);
    const off = h.request(first);
    expect(off.slice(0, first.length)).toEqual(first);
    expect(attached(off).at(-1).content).toContain("Continuity off");
    expect(h.request(first)).toEqual(off);
    await expect(h.call({ action: "list" })).rejects.toThrow("off");
    await h.command("context"); await h.command("status"); expect(waits).toBe(0);
    void h.command("on"); expect(waits).toBe(1);
    expect(f.store.read("anchor").markdown).toBe(f.body);
  } finally { f.clean(); }
});

test("context budget omits whole packet, audit reports omission, unrelated custom messages survive", async () => {
  const f = fixture();
  try {
    f.register(); const h = harness(f); await h.command("attach anchor:5-6"); h.ctx.model.contextWindow = 200;
    const foreign: any = { role: "custom", customType: "foreign", content: "keep", display: false, timestamp: 1 };
    const result = h.request([user("hi"), foreign]); expect(result).toContainEqual(foreign);
    expect(attached(result).at(-1).content).toContain("omitted"); expect(JSON.stringify(result)).not.toContain("mailbox");
    expect((await h.call({ action: "context" })).status).toBe("omitted");
    expect((await h.call({ action: "context" })).content).toBe(attached(result).at(-1).content);
    h.ctx.model.contextWindow = 128000;
    const restored = h.request([user("hi"), foreign]); expect(attached(restored)).toHaveLength(2);
    expect(restored.slice(0, result.length)).toEqual(result);
    const split: any[] = [{ role: "assistant", content: [], timestamp: 1 }, { role: "toolResult", content: [], timestamp: 2 }];
    expect(materialize(split, [], "root", "original", () => {}).messages.slice(0, 2)).toEqual(split);
  } finally { f.clean(); }
});

test("two writers cannot publish the same ID; interrupted locks are not stolen", async () => {
  const f = fixture();
  try {
    const module = resolve(import.meta.dir, "../lib/continuity/store.ts");
    const script = `import {ContinuityStore} from ${JSON.stringify(module)}; const s=new ContinuityStore(${JSON.stringify(f.root)}); try {s.save(s.prepare('race',${JSON.stringify(f.path)}));process.exit(0);}catch(e){process.exit(/conflict|busy/.test(String(e))?2:3);}`;
    const processes = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
    expect((await Promise.all(processes.map(p => p.exited))).sort()).toEqual([0, 2]);
    expect(f.store.list()).toHaveLength(1);
    writeFileSync(join(f.root, ".lock"), "crash marker"); expect(() => f.store.reindex()).toThrow("busy"); expect(readFileSync(join(f.root, ".lock"), "utf8")).toBe("crash marker");
    expect(readdirSync(f.root).some(n => n.startsWith(".pending-"))).toBe(false);
  } finally { f.clean(); }
});

test("changing a source while confirmation is open fails safely; no attachment promotion", async () => {
  const f = fixture();
  try {
    f.register(); const h = harness(f);
    h.ctx.ui.confirm = async () => { writeFileSync(f.path, "different"); return true; };
    await h.command("attach anchor:5-6"); expect(h.notices.at(-1)).toContain("External source");
    expect(h.entries().filter(e => e.type === "custom" && e.customType === STATE)).toHaveLength(0);
    expect(h.entries().filter(e => e.type === "custom" && e.customType === AUDIT)).toHaveLength(0);
    h.ctx.hasUI = false; await expect(h.command("on")).rejects.toThrow("human UI");
  } finally { f.clean(); }
});

test("off and lifecycle changes invalidate pending approvals instead of restoring access later", async () => {
  for (const action of ["on", "attach anchor:5-6", "register second", "refresh anchor", "remove anchor"]) {
    const f = fixture();
    try {
      f.register(); const h = harness(f);
      let approve!: (yes: boolean) => void, entered!: () => void;
      const awaiting = new Promise<void>(resolve => { entered = resolve; });
      h.ctx.ui.confirm = () => { entered(); return new Promise<boolean>(resolve => { approve = resolve; }); };
      const command = h.command(action === "register second" ? `${action} ${f.path}` : action);
      await awaiting;
      await h.command("off"); approve(true); await command;
      expect(h.notices.at(-1)).toContain("approval was pending");
      await expect(h.call({ action: "list" })).rejects.toThrow("off");
      expect(f.store.list()).toHaveLength(1); expect(f.store.read("anchor").markdown).toBe(f.body);
      const pending = h.command("on");
      await Promise.resolve(); await Promise.resolve();
      h.events.session_shutdown!({}, h.ctx); approve(true); await pending;
      expect(h.notices.at(-1)).toContain("approval was pending");
    } finally { f.clean(); }
  }
});

test("read tool content preserves prose indentation rather than using the generic object formatter", async () => {
  const f = fixture();
  try {
    const text = "    An indented thought.\n\tA second one.  \n";
    writeFileSync(f.path, text); f.register(); const h = harness(f); await h.command("on");
    const result = await h.tools.continuity.execute("id", { action: "read", id: "anchor", start: 1, end: 3 }, undefined, undefined, h.ctx);
    expect(result.content[0].text.endsWith(text)).toBe(true);
    expect(result.content[0].text).not.toContain("supersedes earlier"); // a manual read must not replace the attachment
    expect(result.details.result.text).toBe(text);
  } finally { f.clean(); }
});

test("TUI inspection scrolls bounded text and never edits the original", async () => {
  const f = fixture();
  try {
    const h = harness(f); h.ctx.mode = "tui";
    const renders: string[][] = [];
    h.ctx.ui.custom = async (factory: Function) => {
      let rows = 24, closed = false;
      const keys = { matches: (data: string, key: string) => data === key };
      const component = factory({ terminal: { get rows() { return rows; } }, requestRender() {} }, {}, keys, () => { closed = true; });
      for (const width of [1, 10, 80]) {
        rows = width === 1 ? 3 : 24;
        const lines = component.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
        renders.push(lines);
      }
      component.handleInput("tui.select.pageDown"); component.render(80); component.invalidate();
      component.handleInput("tui.select.cancel"); expect(closed).toBe(true);
    };
    await h.command("status"); expect(renders.length).toBe(3);
    expect(h.entries()).toHaveLength(0); expect(readFileSync(f.path, "utf8")).toBe(f.body);
  } finally { f.clean(); }
});

test("ordinary user requests and reload preserve identical provider prefixes without repeated passages", async () => {
  const f = fixture();
  try {
    f.register(); const h = harness(f); await h.command("attach anchor:5-6");
    const base = [user("A")]; h.begin(); const first = h.request(base), entries = h.entries().length;
    const encoded = (messages: any[]) => convertToLlm(messages).map(m => JSON.stringify(m)).join("\n");
    const secondInput = [...base, user("B", 2)]; h.begin(); const second = h.request(secondInput);
    expect(encoded(second).startsWith(encoded(first) + "\n")).toBe(true);
    expect(attached(second)).toHaveLength(1); expect(h.entries()).toHaveLength(entries);
    const restored = harness(f, h.manager); restored.events.session_start!({}, restored.ctx);
    restored.begin(); expect(restored.request(secondInput)).toEqual(second);
    await restored.command("attach anchor:1-3");
    const changed = restored.request(secondInput);
    expect(encoded(changed).startsWith(encoded(second) + "\n")).toBe(true);
    expect(attached(changed)).toHaveLength(2);
    expect(attached(changed).at(-1).content).toContain("supersedes earlier");
    expect(restored.request(changed)).toEqual(changed);
    h.manager.appendCustomEntry("unrelated", { noop: true });
    restored.begin(); expect(restored.request(secondInput)).toEqual(changed);
    const fork = SessionManager.inMemory(f.dir);
    for (const entry of h.manager.getBranch()) if (entry.type === "custom") fork.appendCustomEntry(entry.customType, entry.data);
    const child = harness(f, fork);
    expect(child.request(changed)).toEqual(secondInput); // never re-project a parent's private snapshots
  } finally { f.clean(); }
});

test("continuity composes with workpad fixed-boundary snapshots without shifting either cached prefix", () => {
  const work: Snapshot[] = [], reflect: Snapshot[] = [];
  const project = (messages: any[], task = "Task A", original = "Original A", epoch = "root") => {
    const withWork = snapshotContext(messages, work, epoch, { key: task, content: task }, undefined, s => work.push(s));
    return materialize(withWork, reflect, epoch, original, s => reflect.push(s)).messages;
  };
  const base = [user("A")], first = project(base), next = [...base, user("B", 2)];
  const second = project(next);
  expect(second.slice(0, first.length)).toEqual(first);
  expect(work).toHaveLength(1); expect(reflect).toHaveLength(1);
  const changed = project(next, "Task B", "Original B");
  expect(changed.slice(0, second.length)).toEqual(second);
  expect(project(next, "Task B", "Original B")).toEqual(changed);
  const compacted = project([user("Summary", 3)], "Task B", "Original B", "compact-1");
  expect(attached(compacted)).toHaveLength(1);
  expect(JSON.stringify(compacted)).not.toContain("Original A");
  expect(JSON.stringify(compacted)).not.toContain("Task A");
});
