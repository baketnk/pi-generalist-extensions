// Real Node/Pi loader and loop, synthetic responses only. No external network or personal data.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { saveGeneralistDefaults } from "../../lib/generalist-config.ts";

const root = process.argv[2]!;
saveGeneralistDefaults({ version: 1, meitan: false, memory: false, output: false, websearch: false }, join(root, "extensions", "generalist-settings.json"));
const keyless = process.argv[3] === "keyless";
process.env.GENERALIST_WEB_SEARCH_PROVIDER = keyless ? "auto" : "tavily";
if (!keyless) process.env.TAVILY_API_KEY = "synthetic-web-key";
let requests = 0;
globalThis.fetch = (async (url: URL, init: RequestInit) => {
  assert.equal(String(url), keyless ? "https://mcp.exa.ai/mcp" : "https://api.tavily.com/search");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, keyless ? undefined : "Bearer synthetic-web-key");
  assert.ok(init.signal);
  requests++;
  if (requests > 1) return Response.json({ error: "must not echo synthetic-web-key" }, { status: 429 });
  return keyless ? new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Cedar\nURL: https://example.com/cedar\nHighlights:\nSynthetic cedar snippet" }] } }) + '\n\n', { headers: { "Content-Type": "text/event-stream" } })
    : Response.json({ results: [{ title: "Cedar", url: "https://example.com/cedar", content: "Synthetic cedar snippet" }] });
}) as unknown as typeof fetch;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/generalist.ts", import.meta.url))],
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic web search fixture." });
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
const outgoing: any[] = [];
session.agent.streamFunction = (_model, context) => {
  outgoing.push(JSON.parse(JSON.stringify(context))); turns++;
  const search = turns === 1 || turns === 4;
  const content: AssistantMessage["content"] = search ? [
    { type: "toolCall", id: `search-${turns}`, name: "web_search", arguments: { query: "site:example.com cedar" } },
  ] : [{ type: "text", text: "Done." }];
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: search ? "toolUse" : "stop", content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(); return stream;
};
try {
  assert.ok(!session.agent.state.tools.some(t => t.name === "web_search"));
  assert.equal(requests, 0);
  await session.prompt("/generalist websearch on");
  assert.ok(session.agent.state.tools.some(t => t.name === "web_search"));
  assert.ok(session.agent.state.tools.some(t => t.name === "read"));
  await session.prompt("Search for cedar.");
  const result = session.messages.find(m => m.role === "toolResult" && m.toolName === "web_search");
  assert.ok(result?.role === "toolResult" && !result.isError);
  assert.ok(JSON.stringify(result).includes("Synthetic cedar snippet"));
  assert.ok(!JSON.stringify(result).includes("synthetic-web-key"));
  await session.prompt("An ordinary follow-up.");
  await session.reload();
  assert.ok(session.agent.state.tools.some(t => t.name === "web_search"), "Branch activation must beat saved off default after reload");
  await session.prompt("Search again to exercise HTTP failure.");
  const failed = session.messages.filter(m => m.role === "toolResult").at(-1);
  assert.ok(failed?.isError);
  assert.ok(JSON.stringify(failed).includes("HTTP 429"));
  assert.ok(!JSON.stringify(failed).includes("synthetic-web-key"));
  for (let i = 1; i < outgoing.length; i++) {
    assert.deepEqual(outgoing[i].messages.slice(0, outgoing[i - 1].messages.length), outgoing[i - 1].messages,
      "Search/tool follow-up, ordinary turn and reload must not rewrite the agent-bound transcript prefix");
  }
  await session.prompt("/generalist websearch off");
  assert.ok(!session.agent.state.tools.some(t => t.name === "web_search"));
  assert.deepEqual(errors, []);
  assert.equal(requests, 2);
  console.log(JSON.stringify({ generalistToggle: true, reload: true, errorFlag: true, agentContextPrefix: true, keyless, requests }));
} finally { session.dispose(); }
