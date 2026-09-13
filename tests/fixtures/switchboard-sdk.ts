import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { BoardClient } from "../../lib/switchboard/client.ts";
import { serve } from "../../lib/switchboard/server.ts";
import { secret } from "../../lib/switchboard/shared.ts";

process.umask(0o077);
const root = process.argv[2]!;
globalThis.fetch = (() => { throw new Error("Provider network forbidden in switchboard fixture"); }) as unknown as typeof fetch;
const paths = { root, socket: join(root, "board.sock") }, board = await serve(paths);
const parent = new BoardClient(paths, secret());
const card = { cwd: root, worktree: root, project: root, name: "parent-fixture", summary: "fixture review", activity: "idle" as const };
await parent.connect(card);
const worker = await parent.call<{ id: string; token: string }>("provision", { runId: "fixture-run" });
const workerFile = join(root, "worker.json"); await writeFile(workerFile, JSON.stringify({ token: worker.token }), { mode: 0o600 });
process.env.PI_SWITCHBOARD_WORKER_FILE = workerFile;
process.env.PI_SWITCHBOARD_HOME = root;
process.env.PI_SWITCHBOARD_SOCKET = paths.socket;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/switchboard.ts", import.meta.url))],
  agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Synthetic switchboard SDK test." });
await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModels().find(m => m.provider === "anthropic"); assert.ok(model);
await modelRuntime.setRuntimeApiKey(model.provider, "fixture-not-a-real-key");
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, thinkingLevel: "off", resourceLoader: loader,
  sessionManager: SessionManager.inMemory(root), settingsManager, tools: ["switchboard"] });
const errors: string[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e.error) });
let turns = 0; const outgoing: string[] = []; let inputPromise: Promise<void> | undefined;
session.agent.streamFunction = (_model, context) => {
  outgoing.push(JSON.stringify(context)); turns++;
  const waiting = turns === 1 || turns === 3;
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: waiting ? "toolUse" : "stop",
    content: waiting ? [{ type: "toolCall", id: `wait-${turns}`, name: "switchboard", arguments: { action: "wait", seconds: 10 } }] : [{ type: "text", text: "Fixture done" }],
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); return stream;
};
session.subscribe(event => {
  if (event.type === "tool_execution_start" && event.toolName === "switchboard") {
    setTimeout(() => {
      if (turns === 1) void parent.send("fixture-mail", { recipient: worker.id, body: "private body, not an automatic preview" });
      else if (turns === 3) inputPromise = session.prompt("User interrupt: report status only.", { streamingBehavior: "steer", source: "rpc" });
    }, 30);
  }
});
try {
  for (let i = 0; i < 200 && !board.store.inspect(parent.token, worker.id).online; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));
  await session.prompt("Wait for the peer.");
  assert.equal(turns, 2, JSON.stringify({ errors, messages: session.messages }));
  assert.ok(outgoing[0]!.includes("parent-fixture"));
  assert.ok(!outgoing.join("").includes("private body, not an automatic preview"));
  let results = session.messages.filter(m => m.role === "toolResult");
  assert.ok(JSON.stringify(results[0]).includes('mail'));
  assert.deepEqual(errors, []);
  // Clear pending mail through the authenticated service fixture, not a fake provider request.
  const row = board.store.auth(worker.token), mail = board.store.snapshot(worker.token).inbox[0]!;
  board.store.ack(worker.token, row.runtime, mail.id);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(turns, 2, "No model wake while idle");
  await session.prompt("Wait for user input this time."); await inputPromise;
  results = session.messages.filter(m => m.role === "toolResult");
  assert.ok(JSON.stringify(results[1]).includes("user_input"), JSON.stringify(results));
  assert.deepEqual(errors, []);
  assert.equal(turns, 4);
  await session.prompt("/switchboard off");
  assert.equal(board.store.inspect(parent.token, worker.id).online, false);
  console.log(JSON.stringify({ mailWait: true, userWait: true, turns, noNetwork: true, errors }));
} finally { session.dispose(); await new Promise(r => setTimeout(r, 100)); await board.close(); }
