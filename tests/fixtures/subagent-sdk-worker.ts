/** Synthetic provider, actual production SDK worker entry and process. No provider network. */
import { readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
globalThis.fetch = (() => { throw new Error("Network forbidden in subagent SDK fixture."); }) as unknown as typeof fetch;
const launch = JSON.parse(await readFile(process.argv[2]!, "utf8"));
if (launch.task === "keepalive") setInterval(() => {}, 1000); // Emulate a provider socket surviving session.dispose().
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dirname(process.argv[2]!), "models.json"), allowModelNetwork: false, refreshOnCreate: false });
let turns = 0;
const providerConfig: Parameters<ModelRuntime["registerProvider"]>[1] = { api: "anthropic-messages", baseUrl: "https://network-forbidden.invalid", apiKey: "synthetic-key",
  models: ["inspect", "small"].map(id => ({ id, name: `Inspect fixture ${id}`, reasoning: false, input: ["text"], contextWindow: launch.task === "context-overflow" ? 2048 : 100000, maxTokens: launch.task === "context-overflow" ? 512 : 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  streamSimple(model, context, options) {
    turns++;
    // Capture precisely the provider-bound context, after SDK conversion.
    const saved = appendFile(join(dirname(process.argv[2]!), "payloads.jsonl"), JSON.stringify({ model: { provider: model.provider, id: model.id }, context, options }) + "\n", { mode: 0o600 });
    const tool = (name: string, args: Record<string, unknown>, suffix = "") => ({ type: "toolCall" as const, id: `call-${turns}${suffix}`, name, arguments: args });
    const first = turns === 1;
    const content = launch.task === "silent" ? [{ type: "text" as const, text: "No structured report." }]
      : launch.task === "implement" && turns === 1 ? [tool("write", { path: "implemented.txt", content: "before\n" })]
      : launch.task === "implement" && turns === 2 ? [tool("edit", { path: "implemented.txt", edits: [{ oldText: "before", newText: "after" }] })]
      : launch.task === "implement" && turns === 3 ? [tool("bash", { command: "test \"$(cat implemented.txt)\" = after && printf 'CHECK_PASSED'" })]
      : launch.task === "budget" ? [tool("progress", { text: "more inspection" })]
      : first && launch.task === "block" ? [tool("needs_input", { question: "Which scope?" })]
      : first && launch.task === "forbidden" ? [tool("bash", { command: "touch SHOULD_NOT_EXIST" })]
      : first ? [tool("read", { path: "README.md" })]
      : [tool("report", { outcome: "completed", summary: "Synthetic SDK report", verification: "Read a fixture file, did not run its tests." }), tool(launch.task === "implement" ? "write" : "read", { path: "SHOULD_NOT_EXIST", ...(launch.task === "implement" ? { content: "unauthorized post-report edit" } : {}) }, "-sibling")];
    const message: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), content,
      stopReason: launch.task === "silent" ? "stop" : "toolUse", usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    void saved.then(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
    return stream;
  },
};
runtime.registerProvider("synthetic", providerConfig);
runtime.registerProvider("other-synthetic", providerConfig);
runtime.registerProvider("no-auth", { ...providerConfig, apiKey: undefined });
ModelRuntime.create = async () => runtime;
await import("../../tools/subagent-worker.ts");
