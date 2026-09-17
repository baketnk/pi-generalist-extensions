import assert from "node:assert/strict";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { completeWithPi } from "../../lib/autocomplete/provider.ts";
import { defaults } from "../../lib/autocomplete/config.ts";

globalThis.fetch = (() => { throw Error("Network forbidden in autocomplete fixture"); }) as unknown as typeof fetch;
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: join(process.argv[2]!, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
const calls: any[] = [];
runtime.registerProvider("autocomplete-fixture", { api: "openai-completions", baseUrl: "https://forbidden.invalid", apiKey: "synthetic-key",
  models: [{ id: "small", name: "Small", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model, context, options) {
    calls.push({ model, context, options });
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      content: [{ type: "text", text: "fix the parser" }], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
  },
});
const registry = new ModelRegistry(runtime);
const ctx = { modelRegistry: registry, sessionManager: { buildContextEntries: () => [] } } as any;
const config = { ...defaults, model: "autocomplete-fixture/small" };
assert.equal(await completeWithPi("please ", config, ctx, new AbortController().signal), "fix the parser");
// Exercise the newer facade shape through the actual runtime's provider-aware simple stream too.
(registry as any).streamSimple = runtime.streamSimple.bind(runtime);
assert.equal(await completeWithPi("please ", config, ctx, new AbortController().signal), "fix the parser");
assert.equal(calls.length, 2);
for (const call of calls) {
  assert.equal(call.model.provider, "autocomplete-fixture"); assert.equal(call.options.apiKey, "synthetic-key");
  assert.equal(call.options.maxRetries, 0); assert.equal(call.options.toolChoice, "none");
  assert.equal(call.context.tools, undefined); assert.equal(call.context.messages.length, 1);
}
assert.deepEqual(calls[0].context.messages[0].content, calls[1].context.messages[0].content);
console.log(JSON.stringify({ registeredProvider: true, bothFacadePaths: true, noNetwork: true }));
