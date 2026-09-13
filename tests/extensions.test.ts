import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import meitan, { loadMeitanContext } from "../extensions/meitan.ts";

test("personality is independently off by default and restores branch decisions", async () => {
  const events: Record<string, Function[]> = {}, commands: Record<string, any> = {}, entries: any[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => (events[name] ??= []).push(fn),
    registerFlag() {}, getFlag: () => false,
    registerCommand: (name: string, def: any) => commands[name] = def,
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
  };
  const ctx: any = { hasUI: false, waitForIdle: async () => {}, sessionManager: { getBranch: () => entries } };
  const enabled = meitan(pi);
  for (const fn of events.session_start) await fn({}, ctx);
  expect(enabled()).toBe(false);
  expect(await events.before_agent_start[0]({ systemPrompt: "base" }, ctx)).toBeUndefined();
  await commands.meitan.handler("on", ctx); expect(enabled()).toBe(true);
  await commands.meitan.handler("off", ctx); expect(enabled()).toBe(false);
  entries.pop(); for (const fn of events.session_tree) await fn({}, ctx);
  expect(enabled()).toBe(true);
  entries.length = 0; for (const fn of events.session_start) await fn({}, ctx);
  expect(enabled()).toBe(false);
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
