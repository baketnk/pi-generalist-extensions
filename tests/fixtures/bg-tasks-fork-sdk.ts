// Executed explicitly against PI_FORK_ROOT, using that fork's SDK and serializers.
// Dynamic imports intentionally avoid coupling package typechecking to a sibling checkout.
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import bgTasks from "../../extensions/bg-tasks.ts";

const root = process.argv[2]!;
const fork = process.env.PI_FORK_ROOT!;
const load = (path: string) => import(pathToFileURL(join(fork, path)).href);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await load("packages/coding-agent/src/index.ts");
const { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext } = await load("packages/ai/src/index.ts");
const { getModel, streamSimple } = await load("packages/ai/src/compat.ts");
const agentDir = join(root, "agent"); await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
globalThis.fetch = (() => { throw new Error("Fixture forbids provider transport"); }) as unknown as typeof fetch;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
modelRuntime.registerProvider("synthetic", { api: "anthropic-messages", baseUrl: "https://network-forbidden.invalid", apiKey: "synthetic", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const model = modelRuntime.getModel("synthetic", "fixture");
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic background-delivery fixture. No personal sources.",
  extensionFactories: [bgTasks, (pi: any) => pi.registerTool({ name: "fixture_barrier", label: "Fixture barrier", description: "Fixture only", parameters: Type.Object({}),
    async execute(_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) {
      await writeFile(join(root, "release"), "go");
      const until = Date.now() + 5000;
      while (ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "generalist:bg-tasks:result-v1").length < 2) {
        if (Date.now() > until) throw new Error("fixture jobs did not settle");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return { content: [{ type: "text", text: "Independent fixture work finished" }] };
    },
  })] });
await loader.reload();
const sessionManager = SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, sessionManager, modelRuntime, model, thinkingLevel: "off", tools: ["bg_tasks", "fixture_barrier"] });
const errors: string[] = [];
await session.bindExtensions({ mode: "rpc", onError: (error: any) => errors.push(error.error) });
const contexts: any[] = [];
let request = 0;
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const stream = (_model: unknown, context: any) => {
  contexts.push(normalizeContext({ messages: structuredClone(context.messages) })); request++;
  const content = request === 1 ? [
    call("start-a", "bg_tasks", { action: "start", command: "while [ ! -e release ]; do sleep 0.01; done; printf FIRST", timeoutSeconds: 10 }),
    call("start-b", "bg_tasks", { action: "start", command: "while [ ! -e release ]; do sleep 0.01; done; printf SECOND; exit 3", timeoutSeconds: 10 }),
  ] : request === 2 ? [call("barrier", "fixture_barrier", {})] : [{ type: "text", text: "Observed evidence" }];
  const stopReason = request <= 2 ? "toolUse" : request === 4 ? "error" : "stop";
  const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason,
    ...(stopReason === "error" ? { errorMessage: "503 service unavailable" } : {}), timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const result = createAssistantMessageEventStream();
  if (stopReason === "error") result.push({ type: "error", reason: "error", error: message });
  else result.push({ type: "done", reason: stopReason, message });
  result.end(); return result;
};
session.agent.streamFunction = stream;
try {
  await session.prompt("Run two independent commands; do useful work while they run.");
  assert.equal(request, 3, JSON.stringify({ errors, messages: session.messages }));
  const observations = sessionManager.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === "generalist:bg-tasks:completion-v2");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].details.completions.length, 2);
  assert.match(observations[0].content, /FIRST/); assert.match(observations[0].content, /SECOND/);
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(request, 3, "no late follow-up wake");
  await session.prompt("Ordinary turn, with a synthetic retry."); assert.equal(request, 5);
  await session.reload(); session.agent.streamFunction = stream;
  await session.prompt("After unchanged reload."); assert.equal(request, 6);
  assert.deepEqual(errors, []);
  const project = async (model: any, context: any) => {
    let payload: any;
    const response = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
      apiKey: "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic3ludGhldGljIn19.signature",
      onPayload(value: any) { payload = structuredClone(value); throw new Error("PAYLOAD_ONLY_NO_TRANSPORT"); },
    });
    await response.result(); assert.ok(payload, "serializer reached onPayload"); return payload;
  };
  for (const providerModel of [getModel("openai", "gpt-5.4"), getModel("openai-codex", "gpt-5.5"), getModel("anthropic", "claude-sonnet-4-5")]) {
    const payloads = await Promise.all(contexts.map(context => project(providerModel, context)));
    const raw = payloads.map(p => p.input ?? p.messages);
    const anthropic = providerModel.api === "anthropic-messages";
    const items = anthropic ? raw.map(value => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item))) : raw;
    for (let i = 1; i < payloads.length; i++) {
      assert.deepEqual(payloads[i].tools, payloads[0].tools);
      assert.deepEqual(payloads[i].system ?? payloads[i].instructions, payloads[0].system ?? payloads[0].instructions);
      assert.deepEqual(items[i].slice(0, items[i - 1].length), items[i - 1], `${providerModel.provider} prefix at ${i}`);
    }
    if (anthropic) assert.notDeepEqual(raw[2].slice(0, raw[1].length), raw[1], "native Anthropic cache markers move");
    assert.deepEqual(items[4], items[3], "retry preserves the request");
  }
  console.log(JSON.stringify({ initialRequests: 3, completions: 2, packets: 1, noLateWake: true, providerPrefixes: true, retry: true, reload: true, noNetwork: true }));
} finally { await session.reload(); session.dispose(); }
