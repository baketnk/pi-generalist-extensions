import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { matchesKey } from "@earendil-works/pi-tui";
import switchboard from "../../extensions/switchboard.ts";
import { registerGeneralistSettings } from "../../extensions/generalist-settings.ts";
import { BoardClient } from "../../lib/switchboard/client.ts";
import { serve } from "../../lib/switchboard/server.ts";
import { secret, type Offer } from "../../lib/switchboard/shared.ts";

process.umask(0o077);
const root = process.argv[2]!;
globalThis.fetch = (() => { throw new Error("Provider network forbidden in dashboard fixture"); }) as unknown as typeof fetch;
const paths = { root, socket: join(root, "board.sock") }, board = await serve(paths);
const parent = new BoardClient(paths, secret());
await parent.connect({ project: root, worktree: root, cwd: root, name: "offer-creator", summary: "fixture", activity: "idle" });
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const toggle = Object.assign(() => false, { set() {} });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [pi => switchboard(pi, { paths, ensure: async () => {} }), pi => registerGeneralistSettings(pi, { meitan: toggle, memory: toggle })],
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic dashboard test." });
await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModels().find(m => m.provider === "anthropic"); assert.ok(model);
await modelRuntime.setRuntimeApiKey(model.provider, "fixture-only");
const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off",
  sessionManager: SessionManager.inMemory(root), settingsManager: settings, resourceLoader: loader, tools: ["switchboard"] });
let turns = 0;
const outgoing: any[] = [];
session.agent.streamFunction = (_model, context) => {
  turns++; outgoing.push(JSON.parse(JSON.stringify(context)));
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
    timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Scripted result (not an offer completion fact)." }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
};
const errors: string[] = [], notices: string[] = [];
let mode: "view" | "accept" | "start" = "view";
const sleep = () => new Promise(r => setTimeout(r, 10));
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(); } throw new Error("Fixture timed out"); };
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keys: any = { matches: (data: string, action: string) => matchesKey(data, ({ "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down" } as any)[action] ?? "escape") };
const ui: any = { theme, setStatus() {}, notify: (text: string) => notices.push(text), confirm: async () => true,
  custom: async (factory: any) => {
    let finished = false;
    const component = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, keys, () => { finished = true; });
    try {
      const action = mode; mode = "view";
      if (action === "view") {
        assert.match(component.render(180).join("\n"), /registered\/partial/);
        component.handleInput("/"); component.handleInput("nonmatching"); component.handleInput("\r"); component.render(180);
        component.handleInput("r"); await sleep(); component.handleInput("\x1b");
      } else {
        component.handleInput("\t"); component.handleInput("\t");
        await until(() => component.render(180).join("\n").includes("q_"));
        component.handleInput("\r");
        await until(() => component.render(180).join("\n").includes("Original human task"));
        assert.match(component.render(180).join("\n"), /PRIVATE ORIGINAL TASK/);
        component.handleInput(action === "accept" ? "a" : "s");
      }
      assert.equal(finished, true);
    } finally { component.dispose(); }
  },
};
await session.bindExtensions({ mode: "tui", uiContext: ui, onError: e => errors.push(e.error) });
try {
  let participant: any;
  await until(() => { participant = board.store.snapshot(parent.token).peers[0]; return !!participant; });
  await sleep();
  await session.prompt("Baseline user turn.");
  const before = JSON.stringify(session.messages), system = session.agent.state.systemPrompt, thinking = session.thinkingLevel;
  const tools = JSON.stringify(session.agent.state.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
  await session.prompt("/generalist dashboard");
  assert.equal(turns, 1); assert.equal(JSON.stringify(session.messages), before);
  const originalTask = "PRIVATE ORIGINAL TASK\nKeep this exact wording; do not execute repository mutations in this fixture.";
  const offer = await parent.createOffer("sdk-offer", { recipient: participant.id, worktree: root, originalTask, authority: "human-ui", generation: 0 });
  mode = "accept"; await session.prompt("/switchboard dashboard");
  assert.equal(turns, 1, "Accept must not wake model");
  assert.equal(JSON.stringify(session.messages), before, "Human inspection never copies task to model history");
  assert.equal((await parent.call<Offer>("offer", { op: "inspect", id: offer.id })).state, "accepted");
  mode = "start"; await session.prompt("/generalist dashboard");
  await until(() => turns === 2 && !session.isStreaming);
  await until(() => board.store.offers.request(parent.token, parent.runtime, { op: "inspect", id: offer.id }) !== undefined);
  const delivered = await parent.call<Offer>("offer", { op: "inspect", id: offer.id });
  assert.equal(delivered.state, "delivered", JSON.stringify({ delivered, errors, notices }));
  assert.equal(session.messages.filter(m => m.role === "user" && JSON.stringify(m).includes("PRIVATE ORIGINAL TASK")).length, 1);
  assert.equal(session.agent.state.systemPrompt, system);
  assert.equal(JSON.stringify(session.agent.state.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))), tools);
  assert.equal(session.model?.id, model.id); assert.equal(session.thinkingLevel, thinking);
  assert.deepEqual(outgoing[1].messages.slice(0, outgoing[0].messages.length), outgoing[0].messages, "Provider-bound prefix preserved");
  await session.prompt("/switchboard dashboard"); assert.equal(turns, 2);
  assert.deepEqual(errors, []);
  await session.prompt("/switchboard off");
  console.log(JSON.stringify({ dashboardNoInference: true, explicitOfferDelivery: true, providerPrefix: true, turns, noNetwork: true }));
} finally { session.dispose(); await sleep(); await board.close(); }
