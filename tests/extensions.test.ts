import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import meitan, { loadMeitanContext } from "../extensions/meitan.ts";
import optmem, { validateArgs } from "../extensions/optmem.ts";

function harness() {
  const events: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const entries: any[] = [];
  let active = ["read", "bash", "other"];
  let calls = 0;
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn),
    registerFlag() {}, getFlag: () => false,
    registerCommand: (name: string, def: any) => commands[name] = def,
    registerTool: (def: any) => { tools[def.name] = def; active.push(def.name); },
    getActiveTools: () => active, setActiveTools: (names: string[]) => active = names,
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    exec: async () => { calls++; return { stdout: "You are awake.", stderr: "", code: 0, killed: false }; },
  };
  const ctx: any = { hasUI: false, waitForIdle: async () => {}, sessionManager: { getBranch: () => entries } };
  const emit = async (name: string, event = {}) => {
    const results = [];
    for (const fn of events[name] ?? []) results.push(await fn(event, ctx));
    return results;
  };
  return { pi, ctx, emit, commands, tools, entries, calls: () => calls };
}

test("independent toggles, tool gating, reload/branch restore, no off-state execution", async () => {
  const h = harness(); meitan(h.pi); optmem(h.pi);
  await h.emit("session_start");
  expect(h.pi.getActiveTools()).toEqual(["read", "bash", "other"]);
  expect(await h.emit("before_agent_start", { systemPrompt: "base" })).toEqual([undefined, undefined]);
  await expect(h.tools.memo.execute("id", { args: ["wake"] })).rejects.toThrow("off");
  expect(h.calls()).toBe(0);
  await h.commands.optmem.handler("on", h.ctx);
  expect(h.pi.getActiveTools()).toContain("memo");
  const before = await h.emit("before_agent_start", { systemPrompt: "base" });
  expect(before[0]).toBeUndefined();
  expect(before[1].systemPrompt).toContain("Before other work");
  await h.tools.memo.execute("id", { args: ["wake"] });
  expect((await h.emit("before_agent_start", { systemPrompt: "base" }))[1].systemPrompt).toContain("Memory has been read");
  await h.emit("session_compact");
  expect((await h.emit("before_agent_start", { systemPrompt: "base" }))[1].systemPrompt).toContain("Before other work");
  await h.commands.optmem.handler("off", h.ctx);
  await h.emit("session_start");
  expect(h.pi.getActiveTools()).not.toContain("memo");
  h.entries.pop(); // navigate before the off decision
  await h.emit("session_tree");
  expect(h.pi.getActiveTools()).toContain("memo");
  h.entries.length = 0;
  await h.emit("session_start");
  expect(h.pi.getActiveTools()).not.toContain("memo");
});

test("standalone context loads both files verbatim and fails on missing/oversized input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meitan-test-"));
  try {
    await writeFile(join(dir, "SOUL.md"), "Soul texture 明狸");
    await expect(loadMeitanContext(dir)).rejects.toThrow();
    await writeFile(join(dir, "COMPANION_CONTEXT.md"), "Companion texture");
    expect(await loadMeitanContext(dir)).toContain("Soul texture 明狸");
    expect(await loadMeitanContext(dir)).toContain("Companion texture");
    await writeFile(join(dir, "SOUL.md"), "x".repeat(50_001));
    await expect(loadMeitanContext(dir)).rejects.toThrow("50 KB");
    await expect(loadMeitanContext("relative")).rejects.toThrow("absolute");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("memo exposes only bounded operational commands; shell-looking text remains data", () => {
  for (const args of [["wake"], ["wake", "2", "100"], ["note", "$(touch /tmp/nope)"], ["nap", "0-1", "summary"], ["recall", "a|b"], ["zoom", "0-1"], ["config"]]) expect(() => validateArgs(args)).not.toThrow();
  for (const args of [["init"], ["forget", "0-1"], ["config", "WAKE_LINES=2"], ["note", "a\nb"], ["wake", "; ls"], ["nap", "0-1"]]) expect(() => validateArgs(args)).toThrow();
});
