// Synthetic real Node/Pi loader and agent-loop check; no personal files or network.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { ContinuityStore } from "../../lib/continuity/store.ts";
import { STATE, AUDIT, packet } from "../../lib/continuity/context.ts";

const root = process.argv[2]!;
globalThis.fetch = (() => { throw new Error("Network forbidden in continuity fixture"); }) as unknown as typeof fetch;
const store = new ContinuityStore(join(root, "continuity")), path = join(root, "reflection.md");
writeFileSync(path, "# A reflection\n\nI liked the imperfect mailbox.\nIt was not an obligation.\n");
store.save(store.prepare("anchor", path)); store.reindex();
const manager = SessionManager.inMemory(root), spans = [store.span("anchor", 3, 4)], content = packet(spans);
const state = { version: 1, session: manager.getSessionId(), cwd: root, root: store.root, enabled: true, spans };
manager.appendCustomEntry(STATE, state); // synthetic human-approved grant, not a real user's data
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/continuity.ts", import.meta.url))],
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic continuity test." });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = runtime.getModels().find(m => m.provider === "anthropic"); assert.ok(model);
await runtime.setRuntimeApiKey(model.provider, "fixture-not-a-real-key");
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, thinkingLevel: "off", resourceLoader: loader,
  sessionManager: manager, settingsManager, tools: ["continuity"] });
const errors: string[] = []; await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
let turns = 0; const outgoing: any[] = [];
session.agent.streamFunction = (_model, context) => {
  outgoing.push(JSON.parse(JSON.stringify(context))); turns++;
  const tool = turns === 1 || turns === 5;
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: tool ? "toolUse" : "stop",
    content: tool ? [{ type: "toolCall", id: `read-${turns}`, name: "continuity", arguments: { action: "read", id: "anchor", start: 3, end: 4 } }] : [{ type: "text", text: "Done." }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); return stream;
};
const containsPacket = (ctx: any) => ctx.messages.some((m: any) => m.role === "user" && (m.content === content || m.content?.some?.((c: any) => c.text === content)));
try {
  await session.prompt("Read the selected reflection.");
  assert.equal(turns, 2, JSON.stringify({ messages: session.messages, errors })); assert.ok(containsPacket(outgoing[0])); assert.ok(containsPacket(outgoing[1]));
  assert.equal(session.messages.filter(m => m.role === "toolResult").at(-1)?.isError, false);
  assert.equal(manager.getBranch().filter(e => e.type === "custom" && e.customType === AUDIT).length, 1);
  await session.prompt("An ordinary second user request.");
  assert.equal(turns, 3);
  assert.deepEqual(outgoing[2].messages.slice(0, outgoing[1].messages.length), outgoing[1].messages);
  assert.equal(typeof outgoing[0].systemPrompt, "string"); assert.ok(Array.isArray(outgoing[0].tools));
  assert.equal(outgoing[2].systemPrompt, outgoing[0].systemPrompt);
  assert.deepEqual(outgoing[2].tools, outgoing[0].tools);
  assert.equal(manager.getBranch().filter(e => e.type === "custom" && e.customType === AUDIT).length, 1);
  writeFileSync(path, "A changed original");
  await session.prompt("A new request after source change.");
  assert.equal(turns, 4); assert.ok(containsPacket(outgoing[3])); // already-sent original stays historical
  assert.deepEqual(outgoing[3].messages.slice(0, outgoing[2].messages.length), outgoing[2].messages);
  assert.ok(JSON.stringify(outgoing[3].messages.at(-1)).includes("attachment unavailable"));
  const audit = manager.getBranch().filter(e => e.type === "custom" && e.customType === AUDIT).at(-1);
  assert.ok(audit && audit.type === "custom" && (audit.data as any).status === "unavailable");
  manager.appendCustomEntry(STATE, { ...state, enabled: false, spans: [] });
  await session.prompt("Try reading with access off.");
  assert.equal(turns, 6); assert.ok(containsPacket(outgoing[4]));
  assert.deepEqual(outgoing[4].messages.slice(0, outgoing[3].messages.length), outgoing[3].messages);
  assert.ok(JSON.stringify(outgoing[4].messages.at(-1)).includes("Continuity off"));
  assert.equal(session.messages.filter(m => m.role === "toolResult").at(-1)?.isError, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ turns, stablePacket: true, cachePrefix: true, sourceChange: true, off: true, noNetwork: true }));
} finally { session.dispose(); }
