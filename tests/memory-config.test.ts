import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectFor, readMemoryConfig, saveMemoryConfig, validateConfig, type MemoryConfig } from "../lib/memory/config.ts";
import { POLICY_ENTRY, readMemoryPolicy } from "../lib/memory/policy.ts";
import { MemoryStore } from "../lib/memory/store.ts";
import { decodeTransfer, encodeTransfer, validateNote, validateSnapshot, type Note } from "../lib/memory/schema.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-config-test-")); roots.push(root);
  const config: MemoryConfig = { version: 1, storeRoot: root, storeId: randomUUID(), projects: [{ id: randomUUID(), paths: [root] }], personalIds: [randomUUID()], pins: [] };
  return { root, path: join(root, "native-memory.json"), config };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("config writes are explicit, private, digest-gated and alias-exact", () => {
  const f = fixture(); expect(readMemoryConfig(f.path)).toEqual({ digest: "missing" });
  const digest = saveMemoryConfig(f.path, f.config, "missing");
  expect(readMemoryConfig(f.path)).toEqual({ value: f.config, digest });
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  const before = readFileSync(f.path); expect(() => saveMemoryConfig(f.path, f.config, "missing")).toThrow("changed");
  expect(readFileSync(f.path)).toEqual(before);
  expect(projectFor(f.config, f.root)).toBe(f.config.projects[0].id);
  const sub = join(f.root, "sub"); mkdirSync(sub); expect(projectFor(f.config, sub)).toBeUndefined();
  const alias = join(f.root, "alias"); symlinkSync(f.root, alias); expect(projectFor(f.config, alias)).toBe(f.config.projects[0].id);
});

test("ambiguous aliases, unconfigured pins, unknown fields and symlinked configuration fail", () => {
  const f = fixture();
  expect(() => validateConfig({ ...f.config, projects: [...f.config.projects, { id: randomUUID(), paths: [f.root] }] })).toThrow();
  expect(() => validateConfig({ ...f.config, pins: [{ id: randomUUID(), scope: `personal:${randomUUID()}` }] })).toThrow();
  expect(() => validateConfig({ ...f.config, token: "synthetic-not-a-secret" })).toThrow();
  saveMemoryConfig(f.path, f.config, "missing"); const alias = join(f.root, "config-link.json"); symlinkSync(f.path, alias);
  expect(() => readMemoryConfig(alias)).toThrow(); expect(() => saveMemoryConfig(alias, f.config, "missing")).toThrow();
});

test("default personal identity must belong to configured profiles; legacy configs do not opt in", () => {
  const f = fixture(); saveMemoryConfig(f.path, f.config, "missing");
  expect(readMemoryConfig(f.path).value?.defaultPersonalId).toBeUndefined();
  expect(() => validateConfig({ ...f.config, defaultPersonalId: randomUUID() })).toThrow("not configured");
  expect(() => validateConfig({ ...f.config, defaultPersonalId: "default" })).toThrow("UUID");
  expect(() => validateConfig({ ...f.config, preferMeitanMemory: "yes" })).toThrow("preference");
  const config = { ...f.config, projects: [], defaultPersonalId: f.config.personalIds[0], preferMeitanMemory: true };
  saveMemoryConfig(f.path, config, readMemoryConfig(f.path).digest);
  expect(readMemoryConfig(f.path).value).toEqual(config);
});

test("branch policy restores only its session/cwd, forks stay off, malformed latest state fails closed", () => {
  const sessionId = randomUUID(), cwd = "/synthetic/project", branch: unknown[] = [];
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } } as unknown as ExtensionContext;
  const policy = { version: 1, sessionId, cwd, enabled: true, profile: "project" };
  expect(readMemoryPolicy(ctx).enabled).toBe(false);
  branch.push({ type: "custom", customType: POLICY_ENTRY, data: policy }); expect(readMemoryPolicy(ctx).enabled).toBe(true);
  const fork = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => randomUUID() } } as ExtensionContext;
  expect(readMemoryPolicy(fork).enabled).toBe(false);
  expect(readMemoryPolicy({ ...ctx, cwd: "/synthetic/other" }).enabled).toBe(false);
  branch.push({ type: "custom", customType: POLICY_ENTRY, data: null }); expect(readMemoryPolicy(ctx).enabled).toBe(false);
  branch.push({ type: "custom", customType: POLICY_ENTRY, data: { ...policy, profile: "continuity", personalId: randomUUID() } });
  expect(readMemoryPolicy(ctx).profile).toBe("continuity");
});

test("capture metadata round-trips; old versions reject new fields and invalid authorship", () => {
  const f = fixture(), store = new MemoryStore(f.root); store.initialize();
  const note: Note = { scope: `project:${f.config.projects[0].id}`, kind: "reflection", title: "Synthetic reflection", body: "Fixture only",
    status: "candidate", author: "assistant", sources: [], claim: "inference",
    capture: { harness: "pi", sessionId: randomUUID(), entryId: "abc12345", toolCallId: "fixture-call", provider: "fixture", model: "fixture-model" } };
  const row = store.note(note, randomUUID()), snapshot = decodeTransfer(Buffer.from(store.export()));
  expect(snapshot.version).toBe(4); expect(snapshot.revisions[0].capture).toEqual(row.capture);
  expect(() => validateSnapshot({ ...snapshot, version: 2 })).toThrow("version 3");
  expect(() => validateNote({ ...note, author: "user" })).toThrow("origin");
  expect(() => validateNote({ ...note, claim: "source-backed" })).toThrow("retained source");
  expect(() => validateNote({ ...note, capture: { ...note.capture, secret: "synthetic" } })).toThrow();
  const old = { ...snapshot, version: 2 as const, revisions: snapshot.revisions.map(({ capture, claim, ...r }) => r) };
  const restoredRoot = fixture().root, restored = new MemoryStore(restoredRoot);
  restored.import(Buffer.from(encodeTransfer(old)), false);
  const upgraded = decodeTransfer(Buffer.from(restored.export()));
  expect(upgraded.version).toBe(4); expect(upgraded.revisions).toEqual(old.revisions);
});
