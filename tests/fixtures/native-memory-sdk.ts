// Isolated real Node/Pi agent loop. All data is synthetic; no model or filesystem discovery.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStore } from "../../lib/memory/store.ts";
import { saveMemoryConfig } from "../../lib/memory/config.ts";
import { POLICY_ENTRY } from "../../lib/memory/policy.ts";
import { rebuildRecallIndex } from "../../lib/memory/index.ts";

const root = process.argv[2];
globalThis.fetch = (() => { throw new Error("Network forbidden in native memory fixture"); }) as unknown as typeof fetch;
const store = new MemoryStore(root), storeId = store.initialize(), projectId = randomUUID();
store.note({ scope: `project:${projectId}`, kind: "fact", title: "Fixture", body: "The SDK fixture retains a cedar cache.", author: "user", status: "accepted", sources: [] }, randomUUID());
const configPath = join(root, "native-memory.json"), digest = saveMemoryConfig(configPath, { version: 1, storeRoot: root, storeId,
  projects: [{ id: projectId, paths: [root] }], personalIds: [], pins: [] }, "missing");
rebuildRecallIndex(root, storeId);
const manager = SessionManager.inMemory(root);
manager.appendCustomEntry(POLICY_ENTRY, { version: 1, sessionId: manager.getSessionId(), cwd: root, profile: "project", enabled: true, configDigest: digest });
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/memory.ts", import.meta.url))], agentsFilesOverride: () => ({ agentsFiles: [] }),
  systemPromptOverride: () => "Synthetic SDK test." });
await loader.reload(); loader.getExtensions().runtime.flagValues.set("memory-config", configPath);
assert.equal(loader.getExtensions().errors.length, 0);
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = runtime.getModels().find(m => m.provider === "anthropic"); assert.ok(model);
await runtime.setRuntimeApiKey(model.provider, "fixture-not-a-real-key");
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
  thinkingLevel: "off", resourceLoader: loader, sessionManager: manager, settingsManager, tools: ["memory"] });
const errors: string[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
let turns = 0; const outgoing: string[] = [];
session.agent.streamFunction = (_model, context) => {
  outgoing.push(JSON.stringify(context)); turns++;
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: turns === 1 ? "toolUse" : "stop",
    content: turns === 1 ? [{ type: "toolCall", id: "fixture-native-call", name: "memory", arguments: { action: "note", scope: `project:${projectId}`, kind: "reflection", title: "SDK reflection", body: "Fixture authored reflection" } }] : [{ type: "text", text: "Fixture complete" }],
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); return stream;
};
try {
  await session.prompt("Recall the cedar cache fixture and retain a reflection.");
  assert.equal(turns, 2, JSON.stringify({ messages: session.messages, errors })); assert.deepEqual(errors, []);
  assert.ok(outgoing[0].includes("The SDK fixture retains a cedar cache."));
  assert.ok(!outgoing[1].includes("The SDK fixture retains a cedar cache."), "own write must invalidate automatic packet");
  const results = session.messages.filter(m => m.role === "toolResult"); assert.equal(results.length, 1);
  assert.equal(results[0].isError, false);
  const captures = store.list([`project:${projectId}`], { status: "accepted" }).items;
  const captured = captures.find(r => r.title === "SDK reflection"); assert.ok(captured);
  const record = store.read(captured.id, [`project:${projectId}`]);
  assert.equal(record.capture?.sessionId, manager.getSessionId()); assert.equal(record.capture?.toolCallId, "fixture-native-call");
  assert.ok(manager.getEntry(record.capture!.entryId));
  await session.prompt("/memory off");
  await session.prompt("Another cedar cache question, now memory is off.");
  assert.equal(turns, 3); assert.ok(!outgoing[2].includes("The SDK fixture retains a cedar cache."));
  assert.ok(!session.agent.state.tools.some(t => t.name === "memory"));
  console.log(JSON.stringify({ turns, captureBound: true, packetInvalidated: true, errors }));
} finally { session.dispose(); }
