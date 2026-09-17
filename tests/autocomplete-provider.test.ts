import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { defaults } from "../lib/autocomplete/config.ts";
import { completeWithPi, selectedModel } from "../lib/autocomplete/provider.ts";
import { conversationSnippet, gatherContext, repositorySnippet } from "../lib/autocomplete/context.ts";

const model = { provider: "fixture", id: "luna", api: "openai-completions", baseUrl: "https://configured.invalid" } as any;
const config = { ...defaults, model: "fixture/luna" };
const signal = () => new AbortController().signal;
const entry = (role: string, content: any, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
function stream(text = "fix any failures", reason = "stop") {
  const s = createAssistantMessageEventStream();
  const message = { role: "assistant", content: [{ type: "text", text }], stopReason: reason,
    api: model.api, provider: model.provider, model: model.id, timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
  if (reason === "error" || reason === "aborted") s.push({ type: "error", reason, error: message });
  else s.push({ type: "done", reason: reason as any, message });
  s.end(); return s;
}
function fixture() {
  const calls: any[] = [];
  const entries = [entry("user", "please inspect the parser"), entry("assistant", [{ type: "thinking", thinking: "secret thinking" },
    { type: "toolCall", name: "bash", arguments: { command: "secret-command" } }, { type: "text", text: "The parser needs a boundary test." }]),
    entry("toolResult", "secret-tool-output"), { type: "custom_message", content: "private-memory" }];
  const registry: any = { find: (p: string, id: string) => p === "fixture" && id === "luna" ? model : undefined,
    hasConfiguredAuth: () => true,
    streamSimple: (m: any, context: any, options: any) => { calls.push({ model: m, context, options }); return stream(); } };
  const ctx: any = { modelRegistry: registry, model: { provider: "other", id: "main" }, cwd: "/unused",
    isProjectTrusted: () => true, sessionManager: { buildContextEntries: () => entries } };
  return { ctx, registry, calls, entries };
}

test("Pi provider route uses exact dedicated model, prose-only bounded context, no main-context mutation", async () => {
  const f = fixture(), before = JSON.stringify(f.entries), main = JSON.stringify(f.ctx.model);
  expect(await completeWithPi("please run tests and ", config, f.ctx, signal())).toBe("fix any failures");
  expect(f.calls).toHaveLength(1); const call = f.calls[0];
  expect(call.model).toBe(model); expect(call.context.tools).toBeUndefined();
  expect(call.options.toolChoice).toBe("none"); expect(call.options.maxRetries).toBe(0);
  expect(call.options.sessionId).toBeUndefined(); expect(call.options.maxTokens).toBe(256);
  const payload = JSON.parse(call.context.messages[0].content);
  expect(payload.context.conversation).toEqual([{ role: "user", text: "please inspect the parser" }, { role: "assistant", text: "The parser needs a boundary test." }]);
  expect(payload.context.repository).toEqual([]);
  for (const forbidden of ["secret", "private-memory"]) expect(JSON.stringify(call.context)).not.toContain(forbidden);
  expect(JSON.stringify(f.entries)).toBe(before); expect(JSON.stringify(f.ctx.model)).toBe(main);
  await completeWithPi("x".repeat(4000), { ...config, conversation: false }, f.ctx, signal());
  const payload2 = JSON.parse(f.calls[1].context.messages[0].content);
  expect(payload2.unfinished_draft.length).toBe(2048); expect(payload2.context.conversation).toEqual([]);
});

test("old Pi facade uses registered composed provider, resolved headers/env/baseURL, never global fallback", async () => {
  const f = fixture(); delete f.registry.streamSimple;
  f.registry.getProvider = (id: string) => { expect(id).toBe("fixture"); return { streamSimple: (m: any, context: any, options: any) => {
    f.calls.push({ model: m, context, options }); return stream(" local suffix");
  } }; };
  f.registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "synthetic", headers: { test: "header" }, baseUrl: "https://resolved.invalid", env: { TEST_ENV: "value" } });
  expect(await completeWithPi("draft ", config, f.ctx, signal())).toBe("local suffix");
  expect(f.calls[0].model.baseUrl).toBe("https://resolved.invalid"); expect(model.baseUrl).toBe("https://configured.invalid");
  expect(f.calls[0].options.apiKey).toBe("synthetic"); expect(f.calls[0].options.headers).toEqual({ test: "header" });
  expect(f.calls[0].options.env).toEqual({ TEST_ENV: "value" });
});

test("unknown, unset, unauthenticated and disabled models fail closed without requests", async () => {
  const f = fixture();
  await expect(completeWithPi("draft ", defaults, f.ctx, signal())).rejects.toThrow("Choose");
  await expect(completeWithPi("draft ", { ...config, modelEnabled: false }, f.ctx, signal())).rejects.toThrow("disabled");
  expect(() => selectedModel(f.registry, "fixture/missing")).toThrow("no fallback");
  f.registry.hasConfiguredAuth = () => false;
  await expect(completeWithPi("draft ", config, f.ctx, signal())).rejects.toThrow("authentication");
  expect(f.calls).toHaveLength(0);
});

test("cancellation bounds uncooperative stream and auth setup; no late inference after auth", async () => {
  const f = fixture(); const abort = new AbortController();
  f.registry.streamSimple = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
  const pending = completeWithPi("draft ", config, f.ctx, abort.signal);
  await new Promise(r => setTimeout(r, 0)); abort.abort(); await expect(pending).rejects.toThrow();
  delete f.registry.streamSimple;
  let resolve!: (value: any) => void;
  f.registry.getProvider = () => ({ streamSimple: () => { throw new Error("must not call"); } });
  f.registry.getApiKeyAndHeaders = () => new Promise(r => resolve = r);
  const abort2 = new AbortController(), pending2 = completeWithPi("draft ", config, f.ctx, abort2.signal);
  await new Promise(r => setTimeout(r, 0)); abort2.abort(); await expect(pending2).rejects.toThrow();
  resolve({ ok: true, apiKey: "synthetic" }); await new Promise(r => setTimeout(r, 0));
});

test("provider errors, huge output and tool responses are rejected, terminal escapes are stripped", async () => {
  const f = fixture();
  f.registry.streamSimple = () => stream("do not expose provider error body", "error");
  await expect(completeWithPi("draft ", config, f.ctx, signal())).rejects.toThrow("ended with error");
  f.registry.streamSimple = () => stream("x".repeat(40_000));
  await expect(completeWithPi("draft ", config, f.ctx, signal())).rejects.toThrow("32 KiB");
  f.registry.streamSimple = () => stream("tool text", "toolUse");
  await expect(completeWithPi("draft ", config, f.ctx, signal())).rejects.toThrow("toolUse");
  f.registry.streamSimple = () => stream("draft \x1b[31mclean\u202e");
  expect(await completeWithPi("draft ", config, f.ctx, signal())).toBe("clean");
});

test("conversation selection has fixed count/char bounds, excludes summaries/injections and honors disabled context", async () => {
  const entries = Array.from({ length: 20 }, () => entry("user", "x".repeat(5000)));
  entries.push(entry("user", '{"generation":{"memory":"secret"}}'));
  entries.push(entry("assistant", "failed secret", { stopReason: "error" }));
  const messages = conversationSnippet(entries);
  expect(messages.length).toBeLessThanOrEqual(4); expect(messages.reduce((n, m) => n + m.text.length, 0)).toBe(3000);
  expect(JSON.stringify(messages)).not.toContain("secret");
  const ctx: any = { sessionManager: { buildContextEntries() { throw Error("forbidden"); } } };
  expect(await gatherContext(ctx, false, false, signal())).toEqual({ conversation: [], repository: [] });
});

test("optional repo snippets read only trusted cwd regular files with caps, never ancestors or symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autocomplete-context-")), cwd = join(dir, "repo"); mkdirSync(cwd);
  try {
    writeFileSync(join(dir, "AGENTS.md"), "ancestor secret");
    writeFileSync(join(cwd, "README.md"), "r".repeat(12_000));
    symlinkSync(join(dir, "AGENTS.md"), join(cwd, "AGENTS.md"));
    expect(await repositorySnippet(cwd, signal())).toEqual([{ name: "README.md", text: "r".repeat(1000) }]);
    rmSync(join(cwd, "AGENTS.md")); writeFileSync(join(cwd, "AGENTS.md"), "local conventions");
    const ctx: any = { cwd, isProjectTrusted: () => false };
    await expect(gatherContext(ctx, false, true, signal())).rejects.toThrow("trusted");
    ctx.isProjectTrusted = () => true;
    const result = await gatherContext(ctx, false, true, signal()); expect(result.repository[0]).toEqual({ name: "AGENTS.md", text: "local conventions" });
    expect(JSON.stringify(result)).not.toContain("ancestor secret");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
