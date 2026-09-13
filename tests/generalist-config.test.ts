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
