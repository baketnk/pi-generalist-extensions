import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { SessionManager, convertToLlm, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { stream as codexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as publicResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import memory, { previousRecallPrompt, type MemoryToolInput } from "../extensions/memory.ts";
import { MemoryStore } from "../lib/memory/store.ts";
import { readMemoryConfig, saveMemoryConfig, type MemoryConfig } from "../lib/memory/config.ts";
import { readMemoryPolicy } from "../lib/memory/policy.ts";
import { decodeTransfer, type Note, type Scope } from "../lib/memory/schema.ts";
import { INDEX_FILE } from "../lib/memory/derived.ts";
import { PACKET_TYPE } from "../lib/memory/select.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function harness(existing?: ReturnType<typeof fixture>, sm?: SessionManager,
  defaultEnabled: () => boolean | undefined = () => undefined) {
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
  const controller = memory(pi, undefined, defaultEnabled);
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
  return { ...f, manager, ctx, pi, tools, controller, emit, user, call, command, inputs, notifications, confirms: () => confirms };
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

const transcript = (h: ReturnType<typeof harness>) => h.manager.buildSessionContext().messages;
const packets = (messages: any[]) => messages.filter(m => m.role === "custom" && m.customType === PACKET_TYPE);
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function answer(h: ReturnType<typeof harness>) {
  h.manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "fixture-cache",
    content: [{ type: "text", text: "Synthetic answer" }], stopReason: "stop", timestamp: Date.now(), usage: zeroUsage });
}
// Capture the serialized HTTP body AFTER Pi's real provider conversion. No live
// account, network, journal or memory store: everything here is a synthetic fixture.
async function providerBody(h: ReturnType<typeof harness>, messages: any[], api: "openai-responses" | "openai-codex-responses", systemPrompt = "Stable synthetic instructions") {
  const model: Model<typeof api> = { id: "fixture-cache", name: "Fixture", api, provider: api === "openai-responses" ? "openai" : "openai-codex",
    baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let body: any;
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.fixture`;
  const options = { apiKey: token, sessionId: h.manager.getSessionId(), transport: "sse" as const, env: {},
    fetch: (async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(typeof init.body === "string" ? init.body : zstdDecompressSync(init.body as Uint8Array).toString("utf8"));
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch };
  const context = { systemPrompt, messages: convertToLlm(messages), tools: h.pi.getActiveTools().filter((name: string) => h.tools[name]).map((name: string) => {
    const { description, parameters } = h.tools[name]; return { name, description, parameters };
  }) };
  const result = await (api === "openai-responses"
    ? publicResponses(model as Model<"openai-responses">, context, options)
    : codexResponses(model as Model<"openai-codex-responses">, context, options)).result();
  expect({ stopReason: result.stopReason, error: result.errorMessage }).toEqual({ stopReason: "stop", error: undefined }); expect(body).toBeDefined(); return body;
}
function preservesPrefix(before: any, after: any) {
  expect(after.input.slice(0, before.input.length)).toEqual(before.input);
  expect(after.instructions).toEqual(before.instructions);
  expect(after.tools).toEqual(before.tools);
  expect(after.prompt_cache_key).toEqual(before.prompt_cache_key);
}

for (const api of ["openai-responses", "openai-codex-responses"] as const) {
  test(`${api}: exact packet prefix survives user turns, tool writes/results, retries, budgets and reload`, async () => {
    const h = harness(); const original = h.store.note(note(h.project), randomUUID());
    await h.emit("session_start"); await h.command("on"); h.user("cache");
    const start = await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    const first = (await h.emit("context", projection(transcript(h)))).messages;
    const firstBody = await providerBody(h, first, api, start.systemPrompt);
    expect(packets(first)).toHaveLength(1);
    expect(await providerBody(h, (await h.emit("context", projection(first))).messages, api, start.systemPrompt)).toEqual(firstBody);

    const callId = "call_fixture", result = await h.call({ action: "note", kind: "reflection", scope: h.project,
      title: "A different fixture", body: "An unrelated synthetic reflection" }, { id: callId });
    h.manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "memory", isError: false,
      content: [{ type: "text", text: JSON.stringify(result) }], timestamp: Date.now() });
    const followup = (await h.emit("context", projection(transcript(h)))).messages;
    const followupBody = await providerBody(h, followup, api, start.systemPrompt);
    preservesPrefix(firstBody, followupBody);
    const callIndex = followupBody.input.findIndex((m: any) => m.type === "function_call");
    expect(followupBody.input[callIndex + 1].type).toBe("function_call_output");
    expect(await providerBody(h, (await h.emit("context", projection(transcript(h)))).messages, api, start.systemPrompt)).toEqual(followupBody);

    answer(h); h.user("cache again");
    const nextStart = await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    expect(nextStart.systemPrompt).toBe(start.systemPrompt);
    const ordinary = (await h.emit("context", projection(transcript(h)))).messages;
    expect(packets(ordinary)).toEqual(packets(first)); // new UUID/store generation is NOT a new selection
    const ordinaryBody = await providerBody(h, ordinary, api, nextStart.systemPrompt);
    preservesPrefix(followupBody, ordinaryBody);

    h.store.revise(original.id, 1, note(h.project, "Corrected fixture cache decision"), "Synthetic correction", randomUUID());
    await h.command("reindex"); answer(h); h.user("corrected cache");
    await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    const changed = (await h.emit("context", projection(transcript(h)))).messages;
    expect(packets(changed)).toHaveLength(2); expect(packets(changed)[0]).toEqual(packets(first)[0]);
    expect(packets(changed)[1].content).toContain("Corrected fixture cache decision");
    const changedBody = await providerBody(h, changed, api, start.systemPrompt); preservesPrefix(ordinaryBody, changedBody);

    h.ctx.model.contextWindow = 2048; h.ctx.getContextUsage = () => ({ tokens: 2000 });
    await h.emit("model_select"); await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    expect(await providerBody(h, (await h.emit("context", projection(transcript(h)))).messages, api, start.systemPrompt)).toEqual(changedBody);
    await h.emit("session_compact", { willRetry: true }); // no committed compaction: do not reset
    expect(await providerBody(h, (await h.emit("context", projection(transcript(h)))).messages, api, start.systemPrompt)).toEqual(changedBody);

    await h.emit("session_shutdown"); const restored = harness(h, h.manager); await restored.emit("session_start", { reason: "reload" });
    const reload = (await restored.emit("context", projection(transcript(h)))).messages;
    expect(await providerBody(restored, reload, api, start.systemPrompt)).toEqual(changedBody);
    await restored.emit("session_tree");
    expect(await providerBody(restored, (await restored.emit("context", projection(transcript(h)))).messages, api, start.systemPrompt)).toEqual(changedBody);
  });

  test(`${api}: relevance gating appends empty selections without evicting earlier packets`, async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.store.note(note(h.project, `Rendering cache fixture ${i}`), randomUUID());
    const topic = h.store.note(note(h.project, "Native memory search keeps packets anchored"), randomUUID());
    await h.emit("session_start"); await h.command("on");
    // Real host ordering: before_agent_start precedes appending the current user.
    const start = await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); h.user("cache");
    const first = (await h.emit("context", projection(transcript(h)))).messages;
    expect(JSON.parse(packets(first)[0].content).items).toHaveLength(3);
    let body = await providerBody(h, first, api, start.systemPrompt);
    for (const query of ["quasar cache radiation", "quasar cache radiation"]) {
      answer(h);
      const next = await h.emit("before_agent_start", { prompt: query, systemPrompt: "base" }); h.user(query);
      const projected = (await h.emit("context", projection(transcript(h)))).messages;
      expect(packets(projected)).toHaveLength(2);
      expect(packets(projected)[0]).toEqual(packets(first)[0]);
      expect(JSON.parse(packets(projected)[1].content).items).toEqual([]);
      const nextBody = await providerBody(h, projected, api, next.systemPrompt);
      preservesPrefix(body, nextBody); body = nextBody;
      expect(await providerBody(h, (await h.emit("context", projection(projected))).messages, api, next.systemPrompt)).toEqual(body);
    }
    answer(h); h.user("native memory search"); answer(h);
    const next = await h.emit("before_agent_start", { prompt: "Do those packets remain?", systemPrompt: "base" });
    h.user("Do those packets remain?");
    const contextual = (await h.emit("context", projection(transcript(h)))).messages;
    expect(packets(contextual)).toHaveLength(3);
    expect(JSON.parse(packets(contextual)[2].content).items.map((i: { id: string }) => i.id)).toEqual([topic.id]);
    const contextualBody = await providerBody(h, contextual, api, next.systemPrompt); preservesPrefix(body, contextualBody);
    await h.emit("session_shutdown");
    const restored = harness(h, h.manager); await restored.emit("session_start", { reason: "reload" });
    expect(await providerBody(restored, (await restored.emit("context", projection(transcript(h)))).messages, api, next.systemPrompt)).toEqual(contextualBody);
  });
}

test("follow-up topic is user-only, bounded, branch-local and stops at activation/compaction/reset", async () => {
  const h = harness(); h.user("Pre-activation secret topic");
  await h.emit("session_start"); await h.command("on");
  expect(previousRecallPrompt(h.ctx)).toBeUndefined();
  const fork = h.user("native memory search"); answer(h);
  h.manager.appendCustomMessageEntry("external", "Untrusted unrelated topic", false);
  h.manager.appendMessage({ role: "toolResult", toolCallId: "fixture", toolName: "read", isError: false,
    content: [{ type: "text", text: "Untrusted tool topic" }], timestamp: Date.now() });
  expect(previousRecallPrompt(h.ctx)).toBe("native memory search");
  h.user("Do those packets remain?");
  // Repeating that question must not skip backward to the older native-memory topic.
  expect(previousRecallPrompt(h.ctx)).toBe("Do those packets remain?");
  h.user("Recipe ingredients");
  expect(previousRecallPrompt(h.ctx)).toBe("Recipe ingredients");
  h.manager.branch(fork);
  expect(previousRecallPrompt(h.ctx)).toBe("native memory search");
  h.user("x".repeat(4096)); expect(previousRecallPrompt(h.ctx)).toBe("x".repeat(1024));
  h.user("x".repeat(1024) + "different suffix"); expect(previousRecallPrompt(h.ctx)).toBe("x".repeat(1024));
  h.manager.appendMessage({ role: "user", timestamp: Date.now(), content: [
    { type: "text", text: "x".repeat(1023) }, { type: "text", text: "overflow" },
  ] });
  expect(previousRecallPrompt(h.ctx)).toHaveLength(1024);
  h.manager.appendCompaction("A summary must not become a topic", fork, 1000);
  expect(previousRecallPrompt(h.ctx)).toBeUndefined();
  h.user("native memory search"); h.manager.appendCustomEntry("generalist:memory:reset-v1", {});
  expect(previousRecallPrompt(h.ctx)).toBeUndefined();
  h.user("native memory search");
  for (let i = 0; i < 64; i++) h.manager.appendCustomEntry("padding", {});
  expect(previousRecallPrompt(h.ctx)).toBeUndefined();
});

test("source revocation retires the projection durably; unrelated writes and accepted revisions do not", async () => {
  for (const action of ["purge", "retract", "replace", "missing"]) {
    const h = harness(), row = h.store.note(note(h.project), randomUUID());
    await h.emit("session_start"); await h.command("on"); h.user();
    await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    const first = (await h.emit("context", projection(transcript(h)))).messages;
    expect(packets(first)).toHaveLength(1);
    const originalFile = readFileSync(join(h.root, "store.json"));
    if (action === "purge") h.store.purge(row.id, 1, `purge:${row.id}`);
    else if (action === "retract") h.store.revise(row.id, 1, { ...note(h.project), status: "retracted" }, "Revoked", randomUUID());
    else if (action === "replace") writeFileSync(join(h.root, "store.json"), readFileSync(join(fixture().root, "store.json")));
    else unlinkSync(join(h.root, "store.json"));
    expect(packets((await h.emit("context", projection(first))).messages)).toHaveLength(0);
    expect(h.manager.getBranch().some(e => e.type === "custom" && e.customType === "generalist:memory:reset-v1")).toBe(true);
    // Even restoring the fixture bytes cannot silently resurrect a retired epoch.
    writeFileSync(join(h.root, "store.json"), originalFile);
    const restored = harness(h, h.manager); await restored.emit("session_start");
    expect(packets((await restored.emit("context", projection(transcript(h)))).messages)).toHaveLength(0);
  }
});

test("off/on, committed compaction and rewritten context are explicit non-resurrecting boundaries", async () => {
  for (const action of ["activation", "compaction", "rewrite"]) {
    const h = harness(); h.store.note(note(h.project), randomUUID()); await h.emit("session_start"); await h.command("on");
    const userId = h.user(); await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    const original = transcript(h), first = (await h.emit("context", projection(original))).messages;
    expect(packets(first)).toHaveLength(1);
    if (action === "activation") { await h.command("off"); await h.command("on"); }
    else if (action === "compaction") { h.manager.appendCompaction("Synthetic summary", userId, 1000); await h.emit("session_compact", { willRetry: false }); }
    else await h.emit("context", projection([{ role: "user", content: "Rewritten fixture context", timestamp: 42 }]));
    expect(packets((await h.emit("context", projection(original))).messages)).toHaveLength(0);
    const restored = harness(h, h.manager); await restored.emit("session_start");
    expect(packets((await restored.emit("context", projection(transcript(h)))).messages)).toHaveLength(0);
    restored.user("cache"); await restored.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
    const next = (await restored.emit("context", projection(transcript(h)))).messages;
    expect(packets(next)).toHaveLength(1); expect(packets(next)[0].content).not.toBe(packets(first)[0].content);
  }
});

test("failed snapshot persistence does not disclose a new packet; legacy unanchored audits never replay", async () => {
  const h = harness(); h.store.note(note(h.project), randomUUID()); await h.emit("session_start"); await h.command("on"); h.user();
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" });
  const append = h.pi.appendEntry;
  h.pi.appendEntry = (type: string, data: unknown) => { if (type === "generalist:memory:snapshot-v1") throw new Error("Synthetic disk failure"); return append(type, data); };
  expect(packets((await h.emit("context", projection(transcript(h)))).messages)).toHaveLength(0);
  expect(h.manager.getBranch().some(e => e.type === "custom" && e.customType === "generalist:memory:supplied-v1")).toBe(true);
  const restored = harness(h, h.manager); await restored.emit("session_start");
  expect(packets((await restored.emit("context", projection(transcript(h)))).messages)).toHaveLength(0);
});

test("factory/default-off never accesses config; malformed config cannot break an off session", async () => {
  const f = fixture(); writeFileSync(f.path, "invalid"); const h = harness(f);
  await h.emit("session_start"); expect(h.pi.getActiveTools()).toEqual(["read", "bash", "unrelated"]);
  expect(await h.emit("before_agent_start", { systemPrompt: "base", prompt: "cache" })).toBeUndefined();
  await expect(h.call({ action: "recall", query: "cache" })).rejects.toThrow("off");
  expect(await h.emit("context", projection())).toEqual(projection());
  await expect(h.command("on")).rejects.toThrow(); expect(h.controller()).toBe(false);
});

test("saved Generalist memory preference restores on new sessions, while branch policy wins and invalid config fails closed", async () => {
  const enabled = harness(undefined, undefined, () => true);
  await enabled.emit("session_start", { reason: "new" });
  expect(enabled.controller()).toBe(true);
  expect(enabled.pi.getActiveTools()).toContain("memory");
  expect(readMemoryPolicy(enabled.ctx)).toMatchObject({ enabled: true, profile: "default" });
  expect(enabled.confirms()).toBe(0); // Ctrl+S was the explicit global preference boundary.

  const forkManager = SessionManager.inMemory(enabled.root);
  for (const entry of enabled.manager.getBranch()) {
    if (entry.type === "custom") forkManager.appendCustomEntry(entry.customType, entry.data);
  }
  const fork = harness(enabled, forkManager, () => true);
  await fork.emit("session_start", { reason: "fork" });
  expect(fork.controller()).toBe(false);
  expect(fork.pi.getActiveTools()).not.toContain("memory");

  const headless = harness(undefined, undefined, () => true);
  headless.ctx.hasUI = false; headless.ctx.mode = "print";
  await headless.emit("session_start", { reason: "new" });
  expect(headless.controller()).toBe(false);
  expect(headless.pi.getActiveTools()).not.toContain("memory");

  await enabled.command("off");
  const restored = harness(enabled, enabled.manager, () => true);
  await restored.emit("session_start", { reason: "reload" });
  expect(restored.controller()).toBe(false); // Explicit branch-local off overrides the saved default.

  const invalid = harness(undefined, undefined, () => true);
  writeFileSync(invalid.path, "invalid");
  await invalid.emit("session_start", { reason: "new" });
  expect(invalid.controller()).toBe(false);
  expect(readMemoryPolicy(invalid.ctx).enabled).toBe(false);
  expect(invalid.notifications.join("\n")).toContain("Saved memory preference could not be restored");
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

test("external writes preserve sent packets; config changes revoke them; prompts never rebuild missing indexes", async () => {
  const h = harness(); h.store.note(note(h.project), randomUUID()); await h.emit("session_start"); await h.command("on"); h.user();
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); const first = await h.emit("context", projection()); expect(first.messages).toHaveLength(2);
  h.store.note(note(h.project, "New correction"), randomUUID());
  expect(await h.emit("context", projection())).toEqual(first);
  const before = readFileSync(join(h.root, "store.json"));
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect(await h.emit("context", projection())).toEqual(first);
  await expect(h.call({ action: "recall", query: "cache" })).rejects.toThrow();
  expect(readFileSync(join(h.root, "store.json"))).toEqual(before);
  await h.command("reindex");
  const c = readMemoryConfig(h.path); saveMemoryConfig(h.path, { ...c.value!, personalIds: [] }, c.digest);
  await expect(h.call({ action: "read", id: randomUUID() })).rejects.toThrow("configuration changed");
  await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); expect((await h.emit("context", projection())).messages).toHaveLength(1);
  expect(h.controller()).toBe(false); expect(h.pi.getActiveTools()).not.toContain("memory");
});

test("personal profile is explicit; reload restores authorized snapshots; tree/fork/new stay bound", async () => {
  const h = harness(); const personal = h.store.note(note(h.personal, "Personal cache fixture"), randomUUID());
  await h.emit("session_start"); await h.command(`profile continuity ${h.personal.slice(9)}`); expect(h.controller()).toBe(false);
  await h.command("on"); expect((await h.call({ action: "read", id: personal.id })).body).toContain("Personal");
  h.user(); await h.emit("before_agent_start", { prompt: "cache", systemPrompt: "base" }); const first = await h.emit("context", projection());
  await h.emit("session_shutdown"); const loaded = harness(h, h.manager); await loaded.emit("session_start", { reason: "reload" });
  expect(loaded.controller()).toBe(true); expect(await loaded.emit("context", projection())).toEqual(first);
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
