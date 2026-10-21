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
const publicTools = ["subagent_start", "subagent_fork", "subagent_list", "subagent_models", "subagent_checkpoints",
  "subagent_status", "subagent_peek", "subagent_wait", "subagent_answer", "subagent_guide", "subagent_collect", "subagent_cancel"];
const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager, tools: publicTools });
const errors: string[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
sessionManager.appendCustomEntry(SUBAGENT_MODEL_POLICY_ENTRY, "next-smaller");
let turn = 0, run = "";
const payloads: any[] = [];
const stream: typeof session.agent.streamFunction = (_model, context) => {
  payloads.push(JSON.parse(JSON.stringify(context))); turn++;
  const call = turn === 1 ? { name: "subagent_checkpoints", args: {} }
    : turn === 3 ? { name: "subagent_start", args: { launchKey: "sdk-independent-review", model: "next-smaller", task: "inspect", label: "independent review" } }
    : turn === 5 ? { name: "subagent_start", args: { launchKey: "sdk-independent-review", model: "next-smaller", task: "inspect", label: "independent review" } }
    : turn === 7 ? { name: "subagent_status", args: { runId: "not-an-owned-run" } }
    : turn === 9 ? { name: "subagent_status", args: { runId: run } }
    : turn === 11 ? { name: "subagent_wait", args: { runIds: [run], waitMode: "all", waitTimeoutSeconds: 5 } }
    : turn === 13 ? { name: "subagent_collect", args: { runId: run } }
    : turn === 15 ? { name: "subagent_list", args: {} } : undefined;
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? "toolUse" : "stop",
    content: call ? [{ type: "toolCall", id: `parent-call-${turn}`, name: call.name, arguments: call.args }] : [{ type: "text", text: "Parent did its own useful work." }],
    usage: { input: 30, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 34, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const result = createAssistantMessageEventStream(); result.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); result.end(); return result;
};
session.agent.streamFunction = stream;
const lastResult = () => session.messages.filter(m => m.role === "toolResult").at(-1)!;
try {
  await session.prompt("List explicit fork checkpoints on this unpatched SDK; never invent a selector.");
  assert.match(payloads[0].systemPrompt, /human-locked to next-smaller; you cannot change it/);
  assert.ok(lastResult(), JSON.stringify({ errors, messages: session.messages }));
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  const checkpoints = JSON.parse((lastResult().content[0] as { text: string }).text);
  assert.deepEqual(checkpoints.checkpoints, []);
  assert.match(checkpoints.lastError, /context_snapshot/);
  assert.deepEqual(payloads[0].tools.map((tool: any) => tool.name).sort(), [...publicTools].sort());
  assert.ok(!payloads[0].tools.some((tool: any) => tool.name === "subagents"));
  await session.prompt("Start an independent fresh review; parent can work meanwhile.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  const started = JSON.parse((lastResult().content[0] as { text: string }).text);
  assert.deepEqual(started.model, { provider: "synthetic", id: "small" });
  run = started.runId;
  assert.equal(run, started.id);
  assert.ok(Array.isArray(started.nextCalls));
  assert.ok(run); await new Promise(r => setTimeout(r, 50)); assert.equal(turn, 4, "no idle-parent model wake");
  await session.prompt("Reconcile the identical launch key without starting another worker.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  assert.equal(JSON.parse((lastResult().content[0] as { text: string }).text).runId, run);
  await session.prompt("Exercise an unknown run selector.");
  assert.equal(lastResult().isError, true, JSON.stringify(lastResult()));
  const failure = JSON.parse((lastResult().content[0] as { text: string }).text);
  assert.equal(failure.code, "unknown_run"); assert.equal(failure.retryUnchanged, false);
  assert.equal(failure.nextCalls[0].tool, "subagent_list");
  await session.prompt("Repair the selector using the original owned run.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  await session.prompt("Now wait for the explicitly selected review."); assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  await session.prompt("Collect its report as an unverified claim."); assert.equal(lastResult().isError, false);
  assert.match(JSON.stringify(lastResult()), /Synthetic SDK report/);
  await session.reload(); session.agent.streamFunction = stream;
  await session.prompt("Read status after reload, without restarting any worker.");
  assert.equal(lastResult().isError, false, JSON.stringify(lastResult()));
  assert.match(JSON.stringify(lastResult()), /reportAvailable/);
  assert.equal(JSON.parse((lastResult().content[0] as { text: string }).text).total, 1, "retry must not duplicate a worker");
  for (let i = 1; i < payloads.length; i++) {
    assert.equal(payloads[i].systemPrompt, payloads[0].systemPrompt);
    assert.deepEqual(payloads[i].tools, payloads[0].tools);
    assert.deepEqual(payloads[i].messages.slice(0, payloads[i - 1].messages.length), payloads[i - 1].messages, `prefix changed at request ${i}`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ requests: turn, cachePrefixes: true, reload: true, retryDeduplicated: true, repair: true, noIdleWake: true, missingHookObserved: true, nextSmaller: true, noNetwork: true }));
} finally { session.dispose(); }
