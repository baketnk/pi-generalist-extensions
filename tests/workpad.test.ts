import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import workpad, { ATTACHMENT, CONTEXT } from "../extensions/workpad.ts";
import { WorkpadStore, PAGE_BYTES } from "../lib/workpad/store.ts";
import { WorkpadView, plain } from "../lib/workpad/view.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workpad-test-"));
  const root = join(dir, "pads");
  const store = new WorkpadStore(root, dir);
  return { dir, root, store, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function harness(f: ReturnType<typeof fixture>) {
  const events: Record<string, Function> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {};
  const entries: any[] = [], notices: string[] = [];
  const pi: any = { on: (n: string, fn: Function) => events[n] = fn,
    registerTool: (t: any) => tools[t.name] = t, registerCommand: (n: string, c: any) => commands[n] = c,
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
  };
  const ctx: any = { cwd: f.dir, hasUI: true, mode: "tui", waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
    ui: { setStatus() {}, notify: (text: string) => notices.push(text), editor: async () => undefined, select: async () => undefined },
  };
  workpad(pi, () => f.root);
  const call = async (params: any, signal?: AbortSignal) => JSON.parse((await tools.workpad.execute("id", params, signal, undefined, ctx)).content[0].text);
  return { events, tools, commands, entries, notices, ctx, call };
}

test("workpad storage is lazy; immutable Markdown revisions survive reopening", () => {
  const f = fixture();
  try {
    expect(f.store.list()).toEqual([]); expect(existsSync(f.root)).toBe(false);
    const page = f.store.create("design", "# Design\nMaybe, not established.");
    expect(page.revision).toBe(1); expect(page.path.endsWith("00000001.md")).toBe(true);
    expect(() => f.store.create("design", "another")).toThrow("conflict");
    expect(f.store.update("design", 1, "# Design\nA corrected hypothesis.").revision).toBe(2);
    const reopened = new WorkpadStore(f.root, f.dir);
    expect(reopened.read("design").content).toContain("corrected");
    expect(reopened.read("design", 1).content).toContain("Maybe");
    expect(reopened.list()).toEqual([{ id: "design", revision: 2, title: "Design" }]);
    expect(() => reopened.update("design", 1, "stale")).toThrow("conflict");
    expect(readdirSync(join(f.store.directory, "design"))).toHaveLength(2);
  } finally { f.clean(); }
});

test("page bounds are UTF-8 bytes; invalid IDs, revisions and symlinks fail closed", () => {
  const f = fixture();
  try {
    for (const id of ["../escape", "A", "", "a/b", "a".repeat(65)]) expect(() => f.store.create(id, "text")).toThrow();
    expect(() => f.store.create("empty", " ")).toThrow("empty");
    expect(() => f.store.create("large", "明".repeat(3000))).toThrow("bytes");
    f.store.create("max", "a".repeat(PAGE_BYTES));
    expect(() => f.store.update("max", 0, "x")).toThrow();
    expect(() => f.store.read("max", 999999999)).toThrow();
    const other = join(f.dir, "outside.md"); writeFileSync(other, "outside");
    symlinkSync(other, join(f.store.directory, "max", "00000002.md"));
    expect(() => f.store.read("max")).toThrow();
    symlinkSync(f.dir, join(f.store.directory, "alias"));
    expect(() => f.store.create("alias", "bad")).toThrow("directory");
  } finally { f.clean(); }
});

test("independent writers cannot both publish the same successor", async () => {
  const f = fixture();
  try {
    f.store.create("shared", "initial");
    const module = resolve(import.meta.dir, "../lib/workpad/store.ts");
    const script = `import {WorkpadStore} from ${JSON.stringify(module)}; const s = new WorkpadStore(${JSON.stringify(f.root)},${JSON.stringify(f.dir)}); try {s.update('shared',1,'winner'); process.exit(0);} catch(e) {if(!String(e).includes('conflict')) console.error(e); process.exit(String(e).includes('conflict')?2:3);}`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
    expect((await Promise.all(children.map(c => c.exited))).sort()).toEqual([0, 2]);
    expect(f.store.read("shared").revision).toBe(2);
  } finally { f.clean(); }
});

test("registration/startup is inert; tool create doesn't attach; updates need explicit attachment", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    h.events.session_start!({}, h.ctx);
    expect(existsSync(f.root)).toBe(false);
    await h.call({ action: "create", id: "task", content: "# Tentative" });
    expect(h.entries).toHaveLength(0);
    await expect(h.call({ action: "update", expectedRevision: 1, content: "bad" })).rejects.toThrow("No workpad");
    await h.call({ action: "attach", id: "task" });
    expect(h.entries).toHaveLength(1); expect(h.entries[0].customType).toBe(ATTACHMENT);
    await expect(h.call({ action: "update", id: "other", expectedRevision: 1, content: "bad" })).rejects.toThrow("attached");
    await h.call({ action: "update", expectedRevision: 1, content: "# Corrected" });
    expect((await h.call({ action: "read" })).revision).toBe(2);
    expect((await h.call({ action: "read", revision: 1 })).content).toBe("# Tentative");
    const controller = new AbortController(); controller.abort();
    await expect(h.call({ action: "update", expectedRevision: 2, content: "abort" }, controller.signal)).rejects.toThrow();
    expect(f.store.read("task").revision).toBe(2);
  } finally { f.clean(); }
});

test("context is request-local, current, bounded, low-authority and survives compaction/reload", async () => {
  const f = fixture();
  try {
    const h = harness(f); f.store.create("task", "# Tentative\nNot proven.");
    await h.call({ action: "attach", id: "task" });
    const messages: any[] = [{ role: "user", content: "Do the authorized task", timestamp: 1 }];
    const first = h.events.context!({ messages }, h.ctx).messages;
    expect(messages).toHaveLength(1); expect(h.entries).toHaveLength(1);
    expect(first).toHaveLength(2); expect(first[1].customType).toBe(CONTEXT);
    expect(first[0]).toBe(messages[0]);
    expect(first[1].content).toContain("not a user request");
    expect(convertToLlm(first)[1]!.role).toBe("user");
    expect(h.events.context!({ messages: first }, h.ctx).messages).toHaveLength(2);
    f.store.update("task", 1, "# Revised");
    h.entries.push({ type: "compaction", summary: "old summary" });
    h.events.session_start!({}, h.ctx); // restore from branch, not a closure cache
    const after = h.events.context!({ messages }, h.ctx).messages;
    expect(after[1].content).toContain("revision 2"); expect(after[1].content).toContain("Revised");
    expect(after[1].content).not.toContain("Not proven");
    rmSync(join(f.store.directory, "task"), { recursive: true });
    expect(h.events.context!({ messages }, h.ctx).messages[1].content).toContain("unavailable");
    expect(h.entries).toHaveLength(2);
    await h.call({ action: "detach" });
    expect(h.events.context!({ messages: first }, h.ctx).messages).toEqual(messages);
  } finally { f.clean(); }
});

test("workpad changes preserve the converted transcript prefix across user and tool follow-ups", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    f.store.create("task", "# Original snapshot");
    f.store.create("other", "# Different notebook");
    const messages: any[] = [{ role: "user", content: "Stable history. ".repeat(10000), timestamp: 1 }];
    const request = (input = messages) => h.events.context!({ messages: input }, h.ctx).messages;
    const encoded = (input: any[]) => convertToLlm(input).map(m => JSON.stringify(m)).join("\n");
    const prefix = encoded(messages) + "\n";
    expect(request()).toEqual(messages); // disabled is still inert
    await h.call({ action: "attach", id: "task" });
    const first = request();
    expect(encoded(first).startsWith(prefix)).toBe(true);
    expect(encoded(request())).toBe(encoded(first)); // no timestamp churn
    await h.call({ action: "update", expectedRevision: 1, content: "# Changed snapshot" });
    const changed = request();
    expect(encoded(changed)).not.toBe(encoded(first));
    expect(encoded(changed).startsWith(prefix)).toBe(true);
    expect(changed.at(-1).content).toContain("revision 2");

    // A prior request-local snapshot must not move into the stable transcript,
    // even if a pipeline feeds it back at its former position (or twice).
    const assistant: any = { role: "assistant", content: [
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
    ], timestamp: 2 };
    const results: any[] = ["a", "b"].map(id => ({ role: "toolResult", toolCallId: `call-${id}`,
      toolName: "read", content: [{ type: "text", text: id }], isError: false, timestamp: 3 }));
    const otherContext: any = { role: "custom", customType: "unrelated", content: "Keep me", display: false, timestamp: 4 };
    const tail = [assistant, ...results, otherContext, { role: "user", content: "Continue", timestamp: 5 }];
    const transcript = [...messages, ...tail];
    const fedBack = [...first, ...tail, first.at(-1)];
    const before = JSON.stringify(fedBack);
    const followup = request(fedBack);
    expect(JSON.stringify(fedBack)).toBe(before);
    expect(followup.slice(0, -1)).toEqual(transcript);
    expect(followup.filter((m: any) => m.customType === CONTEXT)).toHaveLength(1);
    expect(encoded(followup).startsWith(encoded(transcript) + "\n")).toBe(true);
    expect(encoded(followup).startsWith(prefix)).toBe(true);
    const toolFollowup = request([...messages, assistant, ...results]);
    expect(toolFollowup.slice(-3).map((m: any) => m.role)).toEqual(["toolResult", "toolResult", "custom"]);

    await h.call({ action: "attach", id: "other" });
    expect(request(transcript).slice(0, -1)).toEqual(transcript);
    expect(request(transcript).at(-1).content).toContain("Different notebook");
    rmSync(join(f.store.directory, "other"), { recursive: true });
    const unavailable = request(transcript);
    expect(encoded(unavailable).startsWith(encoded(transcript) + "\n")).toBe(true);
    expect(unavailable.at(-1).content).toContain("unavailable");
    await h.call({ action: "detach" });
    h.events.session_start!({}, h.ctx);
    expect(request(followup)).toEqual(transcript); // off survives reload
    expect(h.entries).toHaveLength(3); // attachment choices only, never snapshots
  } finally { f.clean(); }
});

test("attachments don't leak to other projects/new/forked sessions; branch navigation restores selection", async () => {
  const f = fixture(), other = fixture();
  try {
    const h = harness(f); f.store.create("task", "# Task");
    await h.call({ action: "attach", id: "task" });
    h.ctx.sessionManager.getSessionId = () => "fork-session";
    expect(h.events.context!({ messages: [] }, h.ctx).messages).toHaveLength(0);
    h.ctx.sessionManager.getSessionId = () => "session-a";
    h.ctx.cwd = other.dir;
    expect(h.events.context!({ messages: [] }, h.ctx).messages).toHaveLength(0);
    h.ctx.cwd = f.dir;
    await h.call({ action: "detach" });
    expect(h.events.context!({ messages: [] }, h.ctx).messages).toHaveLength(0);
    h.entries.pop(); // navigate to before detach
    expect(h.events.context!({ messages: [] }, h.ctx).messages).toHaveLength(1);
    h.entries.length = 0;
    expect(h.events.context!({ messages: [] }, h.ctx).messages).toHaveLength(0);
  } finally { f.clean(); other.clean(); }
});

test("commands support cancellation, explicit attachment, safe editing and recoverable conflict drafts", async () => {
  const f = fixture();
  try {
    const h = harness(f), command = (args: string) => h.commands.workpad.handler(args, h.ctx);
    await command("new draft"); expect(existsSync(f.root)).toBe(false);
    h.ctx.ui.editor = async () => "# User draft";
    await command("new draft"); expect(h.entries).toHaveLength(1);
    let editors = 0;
    h.ctx.ui.editor = async (_title: string, initial: string) => {
      editors++;
      if (editors === 1) { f.store.update("draft", 1, "# Concurrent correction"); return "# My unsaved draft"; }
      expect(_title).toContain("NOT SAVED"); expect(initial).toBe("# My unsaved draft"); return undefined;
    };
    await command("edit");
    expect(editors).toBe(2); expect(f.store.read("draft").content).toBe("# Concurrent correction");
    expect(h.notices.at(-1)).toContain("conflict");
    await command("off"); expect(h.entries.at(-1).data.id).toBeNull();
    await command("attach draft"); expect(h.entries.at(-1).data.id).toBe("draft");
    await command("nonsense"); expect(h.notices.at(-1)).toContain("Usage:");
    h.ctx.mode = "rpc"; await command(""); expect(h.notices.at(-1)).toContain("requires TUI");
  } finally { f.clean(); }
});

test("workpad viewer scrolls, fits resize/tiny terminals and neutralizes terminal controls", () => {
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
});
