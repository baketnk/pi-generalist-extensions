import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import subagents from "../../extensions/subagents.ts";
import { saveModelConfig } from "../../lib/subagents/models.ts";
import { SUBAGENT_MODEL_POLICY_ENTRY } from "../../lib/subagents/model-policy.ts";

const root = process.argv[2]!;
const agentDir = join(root, "config"); await mkdir(agentDir, { mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_CONFIG = join(agentDir, "subagent-models.json");
saveModelConfig(agentDir, { version: 1, ladder: ["synthetic/inspect", "synthetic/small"] });
globalThis.fetch = (() => { throw new Error("Parent SDK fixture forbids provider network."); }) as unknown as typeof fetch;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
modelRuntime.registerProvider("synthetic", { api: "anthropic-messages", baseUrl: "https://network-forbidden.invalid", apiKey: "synthetic", models: ["inspect", "small"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
const model = modelRuntime.getModel("synthetic", "inspect")!;
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic parent. No personal context.",
  extensionFactories: [pi => subagents(pi, { home: join(root, "runs"), workerEntry: fileURLToPath(new URL("./subagent-sdk-worker.ts", import.meta.url)) })] });
await loader.reload();
const sessionManager = SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager, tools: ["subagents"] });
const errors: string[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
sessionManager.appendCustomEntry(SUBAGENT_MODEL_POLICY_ENTRY, "next-smaller");
let turn = 0, run = "";
const payloads: any[] = [];
const stream: typeof session.agent.streamFunction = (_model, context) => {
  payloads.push(JSON.parse(JSON.stringify(context))); turn++;
  const args = turn === 1 ? { action: "start", mode: "fork", task: "inspect", label: "missing hook" }
    : turn === 3 ? { action: "start", mode: "fresh", model: "next-smaller", task: "inspect", label: "independent review" }
    : turn === 5 ? { action: "join", ids: [run], seconds: 5 }
    : turn === 7 ? { action: "collect", id: run }
    : turn === 9 ? { action: "list" } : undefined;
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: args ? "toolUse" : "stop",
    content: args ? [{ type: "toolCall", id: `parent-call-${turn}`, name: "subagents", arguments: args }] : [{ type: "text", text: "Parent did its own useful work." }],
    usage: { input: 30, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 34, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const result = createAssistantMessageEventStream(); result.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); result.end(); return result;
};
session.agent.streamFunction = stream;
const lastResult = () => session.messages.filter(m => m.role === "toolResult").at(-1)!;
try {
  await session.prompt("Try the explicit fork on this unpatched SDK.");
  assert.match(payloads[0].systemPrompt, /human-locked to next-smaller; you cannot change it/);
  assert.ok(lastResult(), JSON.stringify({ errors, messages: session.messages }));
  assert.equal(lastResult().isError, true); assert.match(JSON.stringify(lastResult()), /context_snapshot/);
  await session.prompt("Start an independent fresh review; parent can work meanwhile.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  const started = JSON.parse((lastResult().content[0] as { text: string }).text);
  assert.deepEqual(started.model, { provider: "synthetic", id: "small" });
  run = started.id;
  assert.ok(run); await new Promise(r => setTimeout(r, 50)); assert.equal(turn, 4, "no idle-parent model wake");
  await session.prompt("Now join the review."); assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  await session.prompt("Collect its report as an unverified claim."); assert.equal(lastResult().isError, false);
  assert.match(JSON.stringify(lastResult()), /Synthetic SDK report/);
  await session.reload(); session.agent.streamFunction = stream;
  await session.prompt("Read status after reload, without restarting any worker.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  assert.match(JSON.stringify(lastResult()), /reportAvailable/);
  for (let i = 1; i < payloads.length; i++) {
    assert.equal(payloads[i].systemPrompt, payloads[0].systemPrompt);
    assert.deepEqual(payloads[i].tools, payloads[0].tools);
    assert.deepEqual(payloads[i].messages.slice(0, payloads[i - 1].messages.length), payloads[i - 1].messages, `prefix changed at request ${i}`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ requests: turn, cachePrefixes: true, reload: true, noIdleWake: true, missingHookFails: true, nextSmaller: true, noNetwork: true }));
} finally { session.dispose(); }
