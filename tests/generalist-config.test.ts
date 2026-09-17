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
