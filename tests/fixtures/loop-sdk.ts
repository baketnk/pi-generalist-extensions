import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import loop from "../../extensions/loop.ts";

const root = process.argv[2]!;
const sessionDir = join(root, "sessions");
await mkdir(sessionDir, { recursive: true });
globalThis.fetch = (() => { throw new Error("Network forbidden in loop fixture"); }) as unknown as typeof fetch;
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModels().find(m => m.provider === "anthropic")!;
await modelRuntime.setRuntimeApiKey(model.provider, "fixture-only");
const requests: string[] = [];
let next = 0;
const stream = (_model: unknown, context: any) => {
  const users = context.messages.filter((m: any) => m.role === "user");
  const text = users.at(-1)?.content;
  requests.push(typeof text === "string" ? text : text?.[0]?.text);
  assert.equal(users.length, 1, "each response belongs to a fresh session");
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: `Result ${++next}` }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const events = createAssistantMessageEventStream();
  events.push({ type: "done", reason: "stop", message }); events.end(); return events;
};
const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir: root, modelRuntime,
    resourceLoaderOptions: { extensionFactories: [loop], noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic loop fixture." } });
  const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
  result.session.agent.streamFunction = stream;
  return { ...result, services, diagnostics: services.diagnostics };
}, { cwd: root, agentDir: root, sessionManager: SessionManager.create(root, sessionDir) });
const errors: string[] = [];
const rebind = async () => {
  const session = runtime.session;
  await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error), commandContextActions: {
    waitForIdle: () => session.waitForIdle(),
    newSession: options => runtime.newSession(options),
    fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
    navigateTree: async (targetId, options) => ({ cancelled: (await session.navigateTree(targetId, options)).cancelled }),
    switchSession: (path, options) => runtime.switchSession(path, options),
    reload: async () => { await session.reload(); },
  } });
};
runtime.setRebindSession(rebind); await rebind();
try {
  await runtime.session.prompt("/loop 3 Inspect code carefully");
  assert.deepEqual(requests, ["Inspect code carefully", "Inspect code carefully", "Inspect code carefully"]);
  assert.deepEqual(errors, []);
  const files = (await readdir(sessionDir)).map(f => join(sessionDir, f));
  assert.equal(files.length, 3);
  const headers = await Promise.all(files.map(async file => JSON.parse((await readFile(file, "utf8")).split("\n")[0])));
  assert.equal(new Set(headers.map(h => h.id)).size, 3);
  assert.equal(headers.filter(h => h.parentSession).length, 3);
  assert.equal(headers.filter(h => files.includes(h.parentSession)).length, 2); // The initial empty session is not persisted.
  console.log(JSON.stringify({ sessions: files.length, requests: requests.length, noNetwork: true }));
} finally { await runtime.dispose(); }
