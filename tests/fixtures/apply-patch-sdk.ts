import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";

const root = process.argv[2]!;
globalThis.fetch = (() => { throw new Error("Network forbidden in apply_patch fixture"); }) as unknown as typeof fetch;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/apply-patch.ts", import.meta.url))],
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic local patch test." });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModels().find(m => m.provider === "anthropic"); assert.ok(model);
await modelRuntime.setRuntimeApiKey(model.provider, "fixture-not-a-real-key");
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, thinkingLevel: "off", resourceLoader: loader,
  sessionManager: SessionManager.inMemory(root), settingsManager });
const errors: string[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
let turns = 0;
session.agent.streamFunction = () => {
  turns++;
  const first = turns === 1, failing = turns === 3;
  const content: AssistantMessage["content"] = first ? [
    { type: "toolCall", id: "patch", name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-first old\n+first new\n*** End Patch" } },
    { type: "toolCall", id: "edit", name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "second old", newText: "second new" }] } },
  ] : failing ? [{ type: "toolCall", id: "bad-patch", name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Add File: a.txt\n+overwrite\n*** End Patch" } }]
    : [{ type: "text", text: "Done." }];
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: first || failing ? "toolUse" : "stop", content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); return stream;
};
try {
  assert.ok(!session.agent.state.tools.some(t => t.name === "apply_patch"));
  await session.prompt("/patch on");
  assert.ok(session.agent.state.tools.some(t => t.name === "apply_patch"));
  assert.ok(session.agent.state.tools.some(t => t.name === "edit"));
  await writeFile(join(root, "a.txt"), "first old\nsecond old\n");
  await session.prompt("Run the synthetic concurrent file changes.");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "first new\nsecond new\n");
  const firstResults = session.messages.filter(m => m.role === "toolResult");
  assert.equal(firstResults.length, 2);
  assert.ok(firstResults.every(m => !m.isError));
  await session.prompt("Run the synthetic failing patch.");
  const results = session.messages.filter(m => m.role === "toolResult");
  assert.equal(results.at(-1)?.isError, true);
  assert.ok(JSON.stringify(results.at(-1)).includes("rejected"));
  await session.prompt("/patch off");
  assert.ok(!session.agent.state.tools.some(t => t.name === "apply_patch"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ turns, concurrentBuiltinEdit: true, errorFlag: true, toggle: true, noNetwork: true }));
} finally { session.dispose(); }
