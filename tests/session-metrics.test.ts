import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SESSION_BYTES, readSessionMetrics, summarizeSession } from "../lib/session-metrics.ts";

const header = { type: "session", version: 3 };
const jsonl = (...entries: unknown[]) => [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n";
const assistant = (...names: string[]) => ({ type: "message", message: { role: "assistant", content: names.map(name => ({ type: "toolCall", name })) } });
const trace = (phase: string, id: string, parent = "exec-1", isError = false) => ({ type: "custom", customType: "pi.nested-tool.v1", data: { phase, toolCallId: id, parentToolCallId: parent, toolName: "read", isError } });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await mkdtemp(join(tmpdir(), "session-metrics-")); dirs.push(dir); return join(dir, "session.jsonl"); }

test("counts responses, outer calls, and paired nested calls without inspecting text or code", () => {
  const report = summarizeSession(jsonl(
    { type: "message", message: { role: "user", content: "secret" } },
    assistant("exec", "bash"), trace("start", "a"), trace("start", "b"),
    trace("end", "b", "exec-1", true), trace("end", "a"),
    { type: "message", message: { role: "toolResult", isError: true } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "tools.read()" }] } },
  ));
  expect(report).toMatchObject({ assistantResponses: 2, userMessages: 1, outerToolCalls: 2, execCalls: 1, outerErrorResults: 1,
    nested: { calls: 2, starts: 2, ends: 2, succeeded: 1, failed: 1, unknown: 0, orphanEnds: 0, orchestrators: 1, callsPerOrchestrator: 2 } });
  expect(JSON.stringify(report)).not.toContain("secret");
});

test("start without end is unknown; orphan end and parent-scoped IDs remain distinct", () => {
  const report = summarizeSession(jsonl(trace("start", "a"), trace("end", "a", "other"), trace("end", "b", "other", true)));
  expect(report.nested).toEqual({ calls: 3, starts: 1, ends: 2, succeeded: 1, failed: 1, unknown: 1, orphanEnds: 2, orchestrators: 2, callsPerOrchestrator: 1.5 });
});

test("counts all branches and errors/aborts, not compaction copies or custom injected messages", () => {
  const report = summarizeSession(jsonl(
    { ...assistant("read"), id: "branch-a", parentId: null },
    { ...assistant("bash"), id: "branch-b", parentId: null },
    { type: "compaction", retainedTail: [assistant("read").message] },
    { type: "custom_message", content: "injected" },
    { type: "message", message: { role: "assistant", stopReason: "error" } },
    { type: "message", message: { role: "assistant", stopReason: "aborted" } },
  ));
  expect(report).toMatchObject({ scope: "whole-file-all-branches", assistantResponses: 4, assistantErrors: 1, assistantAborts: 1, outerToolCalls: 2, userMessages: 0 });
  expect(report.nested.callsPerOrchestrator).toBeNull();
});

test("supports v2, CRLF and Unicode separators in JSON strings; labels partial final lines", () => {
  expect(summarizeSession('{"type":"session","version":2}').entries).toBe(0);
  const text = jsonl({ type: "message", message: { role: "user", content: "a\u2028b\u2029c" } }).replaceAll("\n", "\r\n");
  expect(summarizeSession(text).userMessages).toBe(1);
  expect(summarizeSession(text + '{"type":').ignoredPartialFinalLine).toBe(true);
  expect(() => summarizeSession(text + '{"type":\n')).toThrow("Invalid JSON");
});

test("rejects unsupported, malformed and ambiguous records without echoing private contents", () => {
  for (const text of ["", "null", '{"type":"session","version":1}', jsonl(header)]) expect(() => summarizeSession(text)).toThrow();
  expect(() => summarizeSession(jsonl(trace("start", "a"), trace("start", "a")))).toThrow("Duplicate");
  expect(() => summarizeSession(jsonl(trace("oops", "a")))).toThrow("Malformed nested trace");
  expect(() => summarizeSession(jsonl({ type: "custom", customType: "pi.nested-tool.v1", data: { secret: "private" } }))).toThrow("line 2");
  expect(() => summarizeSession(jsonl() + "private\n")).toThrow("Invalid JSON at line 2.");
});

test("enforces line and file caps; explicit file reads leave bytes unchanged", async () => {
  expect(() => summarizeSession(jsonl() + "x".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
  expect(() => summarizeSession(jsonl() + "\n".repeat(100_000))).toThrow("100000 lines");
  const path = await fixture(), text = jsonl(assistant("exec"));
  await writeFile(path, text);
  expect(await readSessionMetrics(path)).toMatchObject({ bytesRead: Buffer.byteLength(text), execCalls: 1 });
  expect(await readFile(path, "utf8")).toBe(text);
  await symlink(path, path + ".link");
  await expect(readSessionMetrics(path + ".link")).rejects.toThrow();
  const handle = await open(path, "r+");
  try { await handle.truncate(MAX_SESSION_BYTES + 1); } finally { await handle.close(); }
  await expect(readSessionMetrics(path)).rejects.toThrow("64 MiB");
});

test("CLI emits only metrics and exits nonzero for invalid input", async () => {
  const path = await fixture();
  await writeFile(path, jsonl(assistant("read")));
  const cli = (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, "../tools/session-metrics.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const ok = cli(path);
  expect(JSON.parse(await new Response(ok.stdout).text()).outerToolCalls).toBe(1);
  expect(await ok.exited).toBe(0);
  for (const args of [[], [path, "extra"], [path + ".missing"]]) {
    const bad = cli(...args);
    expect(await bad.exited).toBe(1);
    expect(await new Response(bad.stdout).text()).toBe("");
  }
});
