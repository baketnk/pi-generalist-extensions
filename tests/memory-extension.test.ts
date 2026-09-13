import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import memory, { type MemoryToolInput } from "../extensions/memory.ts";
import { MemoryStore } from "../lib/memory/store.ts";
import { readMemoryConfig, saveMemoryConfig, type MemoryConfig } from "../lib/memory/config.ts";
import { readMemoryPolicy } from "../lib/memory/policy.ts";
import { decodeTransfer, type Note, type Scope } from "../lib/memory/schema.ts";
import { INDEX_FILE } from "../lib/memory/derived.ts";
import { PACKET_TYPE } from "../lib/memory/select.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function harness(existing?: ReturnType<typeof fixture>, sm?: SessionManager) {
  const f = existing ?? fixture(), manager = sm ?? SessionManager.inMemory(f.root);
  const events: Record<string, Function[]> = {}, tools: Record<string, any> = {}, commands: Record<string, any> = {};
  let active = ["read", "bash", "unrelated"], confirms = 0;
  const notifications: any[] = [], inputs: Array<string | undefined> = [];
  const ctx: any = { cwd: f.root, hasUI: true, mode: "tui", sessionManager: manager,
    model: { contextWindow: 128000 }, getContextUsage: () => ({ tokens: 1000 }), waitForIdle: async () => {},
    ui: { notify: (text: unknown) => notifications.push(text), setStatus() {}, confirm: async () => { confirms++; return true; }, input: async () => inputs.shift() } };
  const pi: any = {
    registerFlag() {}, getFlag: (name: string) => name === "memory-config" ? f.path : undefined,
    on: (name: string, handler: Function) => (events[name] ??= []).push(handler),
    registerCommand: (name: string, command: any) => commands[name] = command,
    registerTool: (tool: any) => { tools[tool.name] = tool; active.push(tool.name); },
    appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data),
    getActiveTools: () => active, setActiveTools: (names: string[]) => active = names,
    exec: () => { throw new Error("No external process permitted"); }, sendMessage: () => { throw new Error("No follow-up permitted"); },
  };
  const controller = memory(pi);
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of events[name] ?? []) { const next = await handler(event, ctx); if (next !== undefined) result = next; }
    return result;
  };
  const user = (content = "Fixture cache choice") => manager.appendMessage({ role: "user", content, timestamp: Date.now() });
  const call = async (args: MemoryToolInput, options: { id?: string; signal?: AbortSignal; bind?: boolean } = {}) => {
    const callId = options.id ?? randomUUID();
    if (options.bind !== false) manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "memory", arguments: args }],
      provider: "fixture-provider", model: "fixture-model", api: "openai-completions", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return (await tools.memory.execute(callId, args, options.signal, undefined, ctx)).details.result;
  };
  const command = (args: string) => commands.memory.handler(args, ctx);
  return { ...f, manager, ctx, pi, controller, emit, user, call, command, inputs, notifications, confirms: () => confirms };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-extension-test-")); roots.push(root);
  const store = new MemoryStore(root), storeId = store.initialize(), path = join(root, "native-memory.json");
  const project: Scope = `project:${randomUUID()}`, personal: Scope = `personal:${randomUUID()}`, other: Scope = `project:${randomUUID()}`;
  const config: MemoryConfig = { version: 1, storeRoot: root, storeId, projects: [{ id: project.slice(8), paths: [root] }], personalIds: [personal.slice(9)], pins: [] };
  saveMemoryConfig(path, config, "missing");
  return { root, store, storeId, path, project, personal, other, config };
}
function note(scope: Scope, body = "Fixture cache decision"): Note { return { scope, kind: "fact", body, title: "Fixture", author: "user", sources: [], status: "accepted" }; }
function projection(messages: any[] = [{ role: "user", content: "Fixture cache choice", timestamp: 1 }]) { return { messages }; }

test("factory/default-off never accesses config; malformed config cannot break an off session", async () => {
  const f = fixture(); writeFileSync(f.path, "invalid"); const h = harness(f);
  await h.emit("session_start"); expect(h.pi.getActiveTools()).toEqual(["read", "bash", "unrelated"]);
  expect(await h.emit("before_agent_start", { systemPrompt: "base", prompt: "cache" })).toBeUndefined();
  await expect(h.call({ action: "recall", query: "cache" })).rejects.toThrow("off");
  expect(await h.emit("context", projection())).toEqual(projection());
  await expect(h.command("on")).rejects.toThrow(); expect(h.controller()).toBe(false);
});

test("scoped packet is frozen and audited once, omitted from session messages, removed on off", async () => {
  const h = harness(); h.store.note(note(h.project), randomUUID()); h.store.note(note(h.personal, "Personal fixture cache"), randomUUID());
  await h.emit("session_start"); await h.command("on"); expect(h.confirms()).toBe(1); h.user();
  const start = await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect(start.systemPrompt).toContain("Native memory");
  const first = await h.emit("context", projection()), packet = first.messages.find((m: any) => m.customType === PACKET_TYPE);
  expect(packet.content).toContain("Fixture cache decision"); expect(packet.content).not.toContain("Personal fixture cache");
  expect(Buffer.byteLength(packet.content)).toBeLessThanOrEqual(8192);
  const second = await h.emit("context", { messages: first.messages }); expect(second).toEqual(first);
  expect(h.manager.getBranch().filter(e => e.type === "custom" && e.customType === "generalist:memory:supplied-v1")).toHaveLength(1);
  expect(h.manager.getBranch().some(e => e.type === "custom_message")).toBe(false);
  await h.emit("session_compact", { willRetry: true }); expect(await h.emit("context", projection())).toEqual(first);
  await h.command("context"); expect(h.notifications.at(-1)).toContain(packet.content.includes("Fixture") ? "Fixture" : "never");
  await h.command("off"); expect((await h.emit("context", { messages: first.messages })).messages).toHaveLength(1);
  expect(h.pi.getActiveTools()).not.toContain("memory"); await expect(h.call({ action: "read", id: randomUUID() })).rejects.toThrow("off");
});

test("host capture and exact source origin survive export; thinking/tools/foreign scope cannot become sources", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on"); const source = h.user("The fixture uses a cache.");
  const args: MemoryToolInput = { action: "note", scope: h.project, kind: "fact", title: "Fixture", body: "The fixture uses a cache.", sourceEntryId: source, excerpt: "uses a cache" };
  const result = await h.call(args), row = h.store.read(result.id, [h.project]);
  expect(row.status).toBe("accepted"); expect(row.capture).toMatchObject({ harness: "pi", sessionId: h.manager.getSessionId(), provider: "fixture-provider", model: "fixture-model" });
  expect(row.sources[0].origin).toEqual({ harness: "pi", sessionId: h.manager.getSessionId(), entryId: source });
  expect(decodeTransfer(Buffer.from(h.store.export())).revisions[0]).toEqual(row);
  await expect(h.call({ ...args, excerpt: "not actually stated" })).rejects.toThrow("exact");
  await expect(h.call({ ...args, scope: h.personal })).rejects.toThrow("scope");
  await expect(h.call(args, { bind: false })).rejects.toThrow("host");
  const thinking = h.manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "uses a cache" }], provider: "fixture", model: "fixture", api: "openai-completions", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await expect(h.call({ ...args, sourceEntryId: thinking })).rejects.toThrow("exact");
  const tool = h.manager.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "fixture", content: [{ type: "text", text: "uses a cache" }], isError: false, timestamp: Date.now() });
  await expect(h.call({ ...args, sourceEntryId: tool })).rejects.toThrow("exact");
  const audit = h.manager.appendCustomEntry("fixture", { text: "uses a cache" });
  await expect(h.call({ ...args, sourceEntryId: audit })).rejects.toThrow("exact");
  const inferred = await h.call({ ...args, inference: true }); expect(inferred.status).toBe("candidate");
  await expect(h.call({ action: "read", id: inferred.id })).rejects.toThrow("not accepted");
  expect((await h.call({ action: "sources" })).sources.some((s: any) => s.entryId === source)).toBe(true);
});

test("native writes are idempotent and revision-safe; manual read respects scope/status", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on"); h.user();
  const args: MemoryToolInput = { action: "note", kind: "reflection", scope: h.project, title: "Fixture", body: "A small fixture reflection" };
  const callId = randomUUID(), row = await h.call(args, { id: callId });
  const retry = await h.call(args, { id: callId, bind: false }); expect(retry.id).toBe(row.id); expect(retry.revision).toBe(1);
  const next = await h.call({ action: "revise", id: row.id, expectedRevision: 1, title: "Revised fixture", body: "Corrected fixture reflection", reason: "Correction" });
  expect(next.revision).toBe(2);
  await expect(h.call({ action: "revise", id: row.id, expectedRevision: 1, title: "Stale", body: "Stale reflection", reason: "Fixture" })).rejects.toThrow("conflict");
  const outside = h.store.note(note(h.other), randomUUID()); await expect(h.call({ action: "read", id: outside.id })).rejects.toThrow("allowed scopes");
  const human = h.store.note(note(h.project), randomUUID());
  await expect(h.call({ action: "revise", id: human.id, expectedRevision: 1, title: "No", body: "No", reason: "No" })).rejects.toThrow("human editing");
});

test("external writes and config changes invalidate current packets; missing index is never rebuilt on prompt", async () => {
  const h = harness(); h.store.note(note(h.project), randomUUID()); await h.emit("session_start"); await h.command("on"); h.user();
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect((await h.emit("context", projection())).messages).toHaveLength(2);
  h.store.note(note(h.project, "New correction"), randomUUID());
  expect((await h.emit("context", projection())).messages).toHaveLength(1);
  const before = readFileSync(join(h.root, "store.json"));
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect((await h.emit("context", projection())).messages).toHaveLength(1);
  await expect(h.call({ action: "recall", query: "cache" })).rejects.toThrow();
  expect(readFileSync(join(h.root, "store.json"))).toEqual(before);
  await h.command("reindex");
  const c = readMemoryConfig(h.path); saveMemoryConfig(h.path, { ...c.value!, personalIds: [] }, c.digest);
  await expect(h.call({ action: "read", id: randomUUID() })).rejects.toThrow("configuration changed");
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect((await h.emit("context", projection())).messages).toHaveLength(1);
  expect(h.controller()).toBe(false); expect(h.pi.getActiveTools()).not.toContain("memory");
});

test("personal profile is explicit; reload resumes grant but never old packet; tree/fork/new stay bound", async () => {
  const h = harness(); const personal = h.store.note(note(h.personal, "Personal cache fixture"), randomUUID());
  await h.emit("session_start"); await h.command(`profile continuity ${h.personal.slice(9)}`); expect(h.controller()).toBe(false);
  await h.command("on"); expect((await h.call({ action: "read", id: personal.id })).body).toContain("Personal");
  h.user(); await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); await h.emit("context", projection());
  await h.emit("session_shutdown"); const loaded = harness(h, h.manager); await loaded.emit("session_start", { reason: "reload" });
  expect(loaded.controller()).toBe(true); expect((await loaded.emit("context", projection())).messages).toHaveLength(1);
  await loaded.command("profile project"); await expect(loaded.call({ action: "read", id: personal.id })).rejects.toThrow("allowed scopes");
  const forkManager = SessionManager.inMemory(h.root); for (const e of h.manager.getBranch()) if (e.type === "custom") forkManager.appendCustomEntry(e.customType, e.data);
  const fork = harness(h, forkManager); await fork.emit("session_start", { reason: "fork" }); expect(fork.controller()).toBe(false);
  const fresh = harness(h); await fresh.emit("session_start", { reason: "new" }); expect(fresh.controller()).toBe(false);
  const branch = h.manager.getBranch()[0].id; h.manager.branch(branch); await loaded.emit("session_tree"); expect(loaded.controller()).toBe(false);
});

test("off/shutdown while a write is queued cancels the mutation; aborted calls never publish", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on"); h.user();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const blocker = withFileMutationQueue(join(h.root, "store.json"), async () => { entered(); await gate; }); await ready;
  const args: MemoryToolInput = { action: "note", kind: "reflection", scope: h.project, title: "Fixture", body: "Queued fixture" };
  const before = h.store.export(), queued = h.call(args).then(() => "unexpected success", error => String(error));
  await h.command("off"); release(); await blocker; expect(await queued).toContain("activation changed"); expect(h.store.export()).toBe(before);
  await h.command("on"); await expect(h.call(args, { signal: AbortSignal.abort() })).rejects.toThrow(); expect(h.store.export()).toBe(before);
  await h.emit("session_shutdown"); await expect(h.call(args)).rejects.toThrow("closed");
});

test("human acceptance/pinning and model budget stay explicit; no automatic reminders", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on"); h.user();
  const candidate = await h.call({ action: "note", kind: "fact", scope: h.project, title: "Fixture", body: "Fixture cache inference" });
  expect(candidate.status).toBe("candidate"); await h.command(`accept ${candidate.id} 1`);
  expect(h.store.read(candidate.id, [h.project]).status).toBe("accepted");
  await h.command(`pin ${candidate.id}`); expect(h.controller()).toBe(false); await h.command("on");
  await expect(h.call({ action: "revise", id: candidate.id, expectedRevision: 2, title: "No", body: "No", reason: "No" })).rejects.toThrow("human editing");
  h.ctx.model.contextWindow = 2048;
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect((await h.emit("context", projection())).messages).toHaveLength(1);
  await h.emit("agent_end", { messages: [] }); // no hook, no extra provider turn
  expect(readMemoryPolicy(h.ctx).profile).toBe("default");
  unlinkSync(join(h.root, INDEX_FILE)); await h.command("reindex");
});

test("configure is explicit and stays off; cancellation and legacy decisions do not grant native access", async () => {
  const h = harness(); h.manager.appendCustomEntry("generalist:optmem:enabled", { enabled: true });
  await h.emit("session_start"); expect(h.controller()).toBe(false);
  h.inputs.push(h.root, h.project.slice(8), ""); await h.command("configure");
  expect(h.confirms()).toBe(1); expect(h.controller()).toBe(false);
  expect(readMemoryConfig(h.path).value?.projects).toEqual(h.config.projects);
  const before = readFileSync(h.path); h.inputs.push(h.root, undefined); await h.command("configure");
  expect(readFileSync(h.path)).toEqual(before);
  h.ctx.hasUI = false; await expect(h.command("on")).rejects.toThrow("human review");
});

test("store replacement refuses reads/writes even if it reuses a configured scope", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on");
  const replacement = fixture(); const row = replacement.store.note(note(h.project), randomUUID());
  writeFileSync(join(h.root, "store.json"), readFileSync(join(replacement.root, "store.json")));
  const before = readFileSync(join(h.root, "store.json"));
  await expect(h.call({ action: "read", id: row.id })).rejects.toThrow("identity changed");
  await expect(h.call({ action: "note", scope: h.project, kind: "reflection", title: "No", body: "No" })).rejects.toThrow("identity changed");
  expect(readFileSync(join(h.root, "store.json"))).toEqual(before);
});

test("two native runtimes share the writer queue but retain independent host provenance", async () => {
  const first = harness(), second = harness(first);
  await first.emit("session_start"); await second.emit("session_start"); await first.command("on"); await second.command("on");
  const args: MemoryToolInput = { action: "note", scope: first.project, kind: "reflection", title: "Fixture", body: "Separate fixture capture" };
  const [a, b] = await Promise.all([first.call(args), second.call(args)]);
  expect(a.id).not.toBe(b.id);
  expect(first.store.read(a.id, [first.project]).capture?.sessionId).toBe(first.manager.getSessionId());
  expect(first.store.read(b.id, [first.project]).capture?.sessionId).toBe(second.manager.getSessionId());
});

function housekeepingHarness() {
  const h = harness(); h.ctx.mode = "rpc";
  const settings = { enabled: true, provider: "fixture-small", model: "small/model" };
  const c = readMemoryConfig(h.path); saveMemoryConfig(h.path, { ...c.value!, housekeeping: settings }, c.digest);
  const calls: any[] = [], reports: string[] = [];
  h.ctx.modelRegistry = {
    find: () => ({ provider: settings.provider, id: settings.model, maxTokens: 4096, contextWindow: 32000 }),
    getAvailable: () => [{ provider: settings.provider, id: settings.model }],
    complete: async (...args: any[]) => { calls.push(args); return { stopReason: "stop", content: [{ type: "text", text: "Review suggestion" }], usage: { totalTokens: 10 } }; },
  };
  h.ctx.ui.editor = async (_title: string, text: string) => { reports.push(text); return "Ignored editor changes"; };
  return { ...h, calls, reports, settings };
}
test("housekeeping is explicitly confirmed, read-only, separate, and not projected to the agent", async () => {
  const h = housekeepingHarness(); await h.emit("session_start");
  const row = h.store.note({ ...note("unassigned"), status: "candidate" }, randomUUID()), before = h.store.export();
  await h.command(`housekeep ${row.id}`);
  expect(h.confirms()).toBe(1); expect(h.calls).toHaveLength(1); expect(h.reports).toEqual(["Review suggestion"]);
  expect(h.store.export()).toBe(before); expect(h.controller()).toBe(false);
  const audit = h.manager.getBranch().filter(e => e.type === "custom" && e.customType === "generalist:memory:housekeeping-run-v1");
  expect(audit).toHaveLength(1); expect(JSON.stringify(audit)).not.toContain("Review suggestion");
  expect((await h.emit("context", projection())).messages).toHaveLength(1);
  const foreign = h.store.note(note(h.other), randomUUID());
  await expect(h.command(`housekeep ${foreign.id}`)).rejects.toThrow("allowed scopes");
  const personal = h.store.note(note(h.personal), randomUUID());
  await expect(h.command(`housekeep ${personal.id}`)).rejects.toThrow("allowed scopes");
  expect(h.calls).toHaveLength(1);
});
test("housekeeping confirmation decline or selection mutation prevents provider disclosure", async () => {
  const h = housekeepingHarness(); const row = h.store.note(note(h.project), randomUUID());
  h.ctx.ui.confirm = async () => false;
  await h.command(`housekeep ${row.id}`); expect(h.calls).toHaveLength(0);
  h.ctx.ui.confirm = async () => { h.store.revise(row.id, 1, note(h.project, "Changed"), "Correction", randomUUID()); return true; };
  await expect(h.command(`housekeep ${row.id}`)).rejects.toThrow("changed"); expect(h.calls).toHaveLength(0);
});
test("off, tree and shutdown cancel workers; stale responses never publish reports", async () => {
  for (const stop of ["off", "session_tree", "session_shutdown", "mutation", "config"]) {
    const h = housekeepingHarness(); await h.emit("session_start"); const row = h.store.note(note(h.project), randomUUID());
    let release!: (value: any) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve);
    h.ctx.modelRegistry.complete = async () => { entered(); return new Promise(resolve => release = resolve); };
    const pending = h.command(`housekeep ${row.id}`).then(() => "success", (error: unknown) => String(error)); await ready;
    await expect(h.command(`housekeep ${row.id}`)).rejects.toThrow("already running");
    if (stop === "off") await h.command("off");
    else if (stop === "mutation") h.store.revise(row.id, 1, note(h.project, "Changed"), "Correction", randomUUID());
    else if (stop === "config") { const c = readMemoryConfig(h.path); saveMemoryConfig(h.path, { ...c.value!, housekeeping: { ...h.settings, enabled: false } }, c.digest); }
    else await h.emit(stop);
    release({ stopReason: "stop", content: [{ type: "text", text: "Stale report" }], usage: {} });
    expect(await pending).not.toBe("success"); expect(h.reports).toHaveLength(0);
  }
});
test("housekeeping settings persist exact model, disable recall, and survive same-store configure", async () => {
  const h = housekeepingHarness(); await h.emit("session_start"); await h.command("on");
  const choices = ["Choose model and enable manual reviews", "fixture-small/small/model"];
  h.ctx.ui.select = async () => choices.shift();
  await h.controller.configureHousekeeping(h.ctx);
  expect(h.controller()).toBe(false); expect(readMemoryConfig(h.path).value?.housekeeping).toEqual(h.settings);
  h.inputs.push(h.root, h.project.slice(8), ""); await h.command("configure");
  expect(readMemoryConfig(h.path).value?.housekeeping).toEqual(h.settings);
  h.ctx.ui.select = async () => "Disable"; await h.command("housekeeping");
  expect(readMemoryConfig(h.path).value?.housekeeping?.enabled).toBe(false);
  await expect(h.command(`housekeep ${randomUUID()}`)).rejects.toThrow("Enable a separate model");
});

function defaultPersonalHarness() {
  const h = harness(), c = readMemoryConfig(h.path);
  saveMemoryConfig(h.path, { ...c.value!, defaultPersonalId: h.personal.slice(9) }, c.digest);
  return h;
}
test("default personal recall works without a project, and project-only remains an explicit exclusion", async () => {
  const h = defaultPersonalHarness(); h.ctx.cwd = fixture().root;
  const personal = h.store.note(note(h.personal, "Personal fixture cache"), randomUUID());
  h.store.note(note(h.project, "Other directory fixture cache"), randomUUID());
  await h.emit("session_start"); expect(h.controller()).toBe(false);
  await h.command("on"); h.user();
  const start = await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
  expect(start.systemPrompt).toContain(h.personal); expect(start.systemPrompt).not.toContain(h.project);
  const packet = (await h.emit("context", projection())).messages.find((m: any) => m.customType === PACKET_TYPE);
  expect(packet.content).toContain("Personal fixture cache"); expect(packet.content).not.toContain("Other directory");
  expect((await h.call({ action: "read", id: personal.id })).scope).toBe(h.personal);
  await h.command("off"); await h.command("profile project");
  await expect(h.command("on")).rejects.toThrow("No configured memory scope");
  await h.command("profile default"); await h.command("on"); expect(h.controller()).toBe(true);
});
test("mapped project and default personal notes coexist; explicit project-only survives reload", async () => {
  const h = defaultPersonalHarness();
  const project = h.store.note(note(h.project, "Fixture uses tabs"), randomUUID());
  const personal = h.store.note(note(h.personal, "Fixture preference: spaces"), randomUUID());
  await h.emit("session_start"); await h.command("on"); h.user();
  const start = await h.emit("before_agent_start", { prompt: "Fixture", systemPrompt: "base" });
  expect(start.systemPrompt).toContain("project-specific exceptions take precedence");
  expect(start.systemPrompt).toContain(h.project); expect(start.systemPrompt).toContain(h.personal);
  const result = await h.call({ action: "recall", query: "Fixture" });
  expect(result.items.map((r: any) => r.id)).toEqual([project.id, personal.id]);
  await h.command("profile project");
  expect((await h.call({ action: "recall", query: "Fixture" })).items.map((r: any) => r.id)).toEqual([project.id]);
  await h.emit("session_shutdown"); const restored = harness(h, h.manager); await restored.emit("session_start");
  expect(restored.controller()).toBe(true); expect(readMemoryPolicy(restored.ctx).profile).toBe("project");
  await expect(restored.call({ action: "read", id: personal.id })).rejects.toThrow("allowed scopes");
});
test("personal setting is confirmed, cancellation-safe, persistent, and never grants activation", async () => {
  const h = harness(); await h.emit("session_start"); await h.command("on");
  h.ctx.ui.select = async () => "Use/create default personal profile";
  h.inputs.push(""); h.ctx.ui.confirm = async () => false;
  const before = readMemoryConfig(h.path).digest;
  await h.controller.configurePersonal(h.ctx); expect(readMemoryConfig(h.path).digest).toBe(before);
  h.inputs.push(""); h.ctx.ui.confirm = async () => true;
  await h.command("personal"); const config = readMemoryConfig(h.path).value!;
  expect(config.personalIds).toContain(config.defaultPersonalId!); expect(h.controller()).toBe(false);
  expect(readMemoryPolicy(h.ctx).profile).toBe("default");
  h.ctx.ui.select = async () => "Project-only default"; await h.command("personal");
  expect(readMemoryConfig(h.path).value?.defaultPersonalId).toBeUndefined();
  expect(readMemoryConfig(h.path).value?.personalIds).toEqual(config.personalIds); // never deletes data/profile identities
});
test("changing default profile suspends old grants; new/fork sessions still start off", async () => {
  const h = defaultPersonalHarness(); await h.emit("session_start"); await h.command("on");
  const c = readMemoryConfig(h.path), next = { ...c.value! }; delete next.defaultPersonalId; saveMemoryConfig(h.path, next, c.digest);
  await h.emit("before_agent_start", { prompt: "fixture", systemPrompt: "base" }); expect(h.controller()).toBe(false);
  await expect(h.call({ action: "recall", query: "fixture" })).rejects.toThrow("configuration changed");
  const forkManager = SessionManager.inMemory(h.root);
  for (const e of h.manager.getBranch()) if (e.type === "custom") forkManager.appendCustomEntry(e.customType, e.data);
  const fork = harness(h, forkManager); await fork.emit("session_start"); expect(fork.controller()).toBe(false);
});
test("pairing preference alone never enables memory; personal-only configure needs no project UUID", async () => {
  const h = harness(); await h.emit("session_start");
  h.ctx.ui.select = async () => "Yes"; await h.controller.configurePairing(h.ctx);
  expect(h.controller.prefersCompanion()).toBe(true); expect(h.controller()).toBe(false);
  h.inputs.push(h.root, "", "new"); await h.command("configure");
  expect(readMemoryConfig(h.path).value?.projects).toEqual(h.config.projects);
  expect(readMemoryConfig(h.path).value?.defaultPersonalId).toBeDefined();
  expect(readMemoryConfig(h.path).value?.preferMeitanMemory).toBe(true);
  const newStore = fixture(); h.inputs.push(newStore.root, "", "new"); await h.command("configure");
  const c = readMemoryConfig(h.path).value!;
  expect(c.projects).toEqual([]); expect(c.personalIds).toEqual([c.defaultPersonalId!]);
  expect(c.preferMeitanMemory).toBeUndefined(); expect(h.controller()).toBe(false);
  h.controller.enableDefault(h.ctx); expect(h.controller()).toBe(true);
});
