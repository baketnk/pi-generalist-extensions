import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generalistConfigPath, loadGeneralistDefaults, saveGeneralistDefaults } from "../lib/generalist-config.ts";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "generalist-defaults-")); roots.push(path); return path; }

test("Generalist defaults write atomically and load only the supported schema", () => {
  const dir = root(), path = generalistConfigPath(dir);
  const defaults = { version: 1 as const, meitan: true, output: true, patch: false, icons: true };
  saveGeneralistDefaults(defaults, path);
  expect(loadGeneralistDefaults(path)).toEqual(defaults);

  writeFileSync(path, JSON.stringify({ ...defaults, unknown: true }));
  expect(loadGeneralistDefaults(path)).toBeUndefined();

  writeFileSync(path, "not json");
  expect(loadGeneralistDefaults(path)).toBeUndefined();
});

test("Generalist config path is kept beneath Pi's agent directory", () => {
  expect(generalistConfigPath("/tmp/pi-agent")).toBe("/tmp/pi-agent/extensions/generalist-settings.json");
});

test("loop limit saves and loads without rejecting older defaults", () => {
  const path = generalistConfigPath(root());
  const base = { version: 1 as const, meitan: false, output: false };
  saveGeneralistDefaults(base, path);
  expect(loadGeneralistDefaults(path)).toEqual(base);
  for (const loopLimit of [1, 10, 1000]) {
    saveGeneralistDefaults({ ...base, loopLimit }, path);
    expect(loadGeneralistDefaults(path)?.loopLimit).toBe(loopLimit);
  }
  for (const loopLimit of [0, -1, 1.2, 1001, "10", null]) {
    expect(() => saveGeneralistDefaults({ ...base, loopLimit } as any, path)).toThrow();
  }
});

afterAll(() => roots.forEach(path => rmSync(path, { recursive: true, force: true })));

test("memory default is backward compatible and strictly boolean", () => {
  const path = generalistConfigPath(root());
  saveGeneralistDefaults({ version: 1, meitan: false, memory: true, output: false }, path);
  expect(loadGeneralistDefaults(path)?.memory).toBe(true);
  saveGeneralistDefaults({ version: 1, meitan: false, output: false }, path);
  expect(loadGeneralistDefaults(path)?.memory).toBeUndefined();
  expect(() => saveGeneralistDefaults({ version: 1, meitan: false, memory: "on", output: false } as any, path)).toThrow();
});

test("background model defaults round-trip exact identity or clear, with strict validation", () => {
  const path = generalistConfigPath(root());
  const base = { version: 1 as const, meitan: false, output: false };
  for (const backgroundModel of [undefined, null, { provider: "Local", model: "Org/Small" }]) {
    saveGeneralistDefaults({ ...base, backgroundModel }, path);
    expect(loadGeneralistDefaults(path)?.backgroundModel).toEqual(backgroundModel);
  }
  for (const backgroundModel of [false, {}, { provider: "", model: "x" }, { provider: "p", model: "x\n" }, { provider: "p", model: "x", apiKey: "secret" }]) {
    expect(() => saveGeneralistDefaults({ ...base, backgroundModel } as any, path)).toThrow();
  }
});

test("forced subagent model defaults accept named and exact specifiers only", () => {
  const path = generalistConfigPath(root());
  const base = { version: 1 as const, meitan: false, output: false };
  for (const forcedSubagentModel of [undefined, null, "self", "next-smaller", "Local/Org/Small"]) {
    saveGeneralistDefaults({ ...base, forcedSubagentModel }, path);
    expect(loadGeneralistDefaults(path)?.forcedSubagentModel).toBe(forcedSubagentModel);
  }
  for (const forcedSubagentModel of [false, "same", "bare", "/model", "provider/", "provider/x\n"]) {
    expect(() => saveGeneralistDefaults({ ...base, forcedSubagentModel } as any, path)).toThrow();
  }
});
