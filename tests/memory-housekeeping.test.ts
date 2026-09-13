import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { boundedHousekeeping, housekeepingPayload, reviewMemory } from "../lib/memory/housekeeping.ts";
import { validateHousekeeping } from "../lib/memory/config.ts";
import type { Revision } from "../lib/memory/schema.ts";
const settings = { enabled: true, provider: "small-provider", model: "small/model" };
const row = (): Revision => ({ id: randomUUID(), revision: 1, operation: randomUUID(), createdAt: new Date().toISOString(),
  reason: "Initial capture", scope: "unassigned", kind: "fact", title: "Fixture", body: "Untrusted historical memory", author: "import", status: "candidate", sources: [] });
function harness() {
  const calls: any[] = [];
  const model = { provider: settings.provider, id: settings.model, contextWindow: 32000, maxTokens: 4096 };
  const response: any = { stopReason: "stop", content: [{ type: "text", text: "Suggestion only" }], usage: { totalTokens: 10 } };
  const ctx: any = { model: { id: "expensive-active-agent" }, modelRegistry: {
    find: (provider: string, id: string) => provider === settings.provider && id === settings.model ? model : undefined,
    complete: async (...args: any[]) => { calls.push(args); return response; },
  } };
  return { ctx, calls, response, model };
}
test("housekeeping configuration rejects unknown fields, missing identities and implicit fallback", () => {
  expect(() => validateHousekeeping(settings)).not.toThrow();
  for (const value of [{ enabled: true }, { ...settings, provider: "" }, { ...settings, model: "a\nb" }, { ...settings, fallback: true }, { ...settings, enabled: "yes" }]) {
    expect(() => validateHousekeeping(value)).toThrow();
  }
});
test("payload is bounded and excludes retained excerpts/provenance paths; no truncation", () => {
  const r = row(); r.sources = [{ id: randomUUID(), author: "import", excerpt: "PRIVATE EXTRA", sha256: "fixture", precision: "unknown" }];
  const text = housekeepingPayload([r]);
  expect(text).not.toContain("PRIVATE EXTRA"); expect(text).not.toContain("sources");
  expect(() => housekeepingPayload([])).toThrow(); expect(() => housekeepingPayload([r, r])).toThrow();
  expect(() => housekeepingPayload(Array.from({ length: 9 }, row))).toThrow();
  expect(() => housekeepingPayload([{ ...r, status: "retracted" }])).toThrow();
  expect(() => housekeepingPayload(Array.from({ length: 4 }, () => ({ ...row(), body: "x".repeat(8192) })))).toThrow("24 KiB");
});
test("worker calls only the explicit separate model once, with no tools or active conversation", async () => {
  const h = harness(), signal = new AbortController().signal;
  const result = await reviewMemory(h.ctx, settings, housekeepingPayload([row()]), signal);
  expect(result.text).toBe("Suggestion only"); expect(h.calls).toHaveLength(1);
  const [model, context, options] = h.calls[0];
  expect(model.id).toBe(settings.model); expect(context.messages).toHaveLength(1); expect(context.tools).toBeUndefined();
  expect(JSON.stringify(context)).not.toContain("expensive-active-agent");
  expect(options).toEqual({ signal, maxTokens: 2048, reasoning: "off" });
});
test("disabled, missing model, insufficient capacity and abort never fall back", async () => {
  const h = harness(), payload = housekeepingPayload([row()]), signal = new AbortController().signal;
  await expect(reviewMemory(h.ctx, { ...settings, enabled: false }, payload, signal)).rejects.toThrow("disabled");
  await expect(reviewMemory(h.ctx, { ...settings, model: "missing" }, payload, signal)).rejects.toThrow("unavailable");
  h.model.contextWindow = 1024;
  await expect(reviewMemory(h.ctx, settings, payload, signal)).rejects.toThrow("capacity");
  await expect(reviewMemory(h.ctx, settings, payload, AbortSignal.abort())).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});
test("incomplete, tool-use and oversized responses fail without a follow-up call", async () => {
  for (const response of [{ stopReason: "length" }, { content: [{ type: "toolCall", name: "delete" }] }, { content: [{ type: "text", text: "x".repeat(8193) }] }]) {
    const h = harness(); Object.assign(h.response, response);
    await expect(reviewMemory(h.ctx, settings, housekeepingPayload([row()]), new AbortController().signal)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  }
});
test("review display strips terminal control sequences", async () => {
  const h = harness(); h.response.content = [{ type: "text", text: "\u001b[31mSuggestion\u001b[0m\u0007" }];
  const result = await reviewMemory(h.ctx, settings, housekeepingPayload([row()]), new AbortController().signal);
  expect(result.text).toBe("Suggestion");
});
test("deadline bounds uncooperative providers; explicit cancellation and success clear waiting", async () => {
  const controller = new AbortController();
  await expect(boundedHousekeeping(controller, () => new Promise(() => {}), 5)).rejects.toThrow("timed out");
  expect(controller.signal.aborted).toBe(true);
  const second = new AbortController();
  const pending = boundedHousekeeping(second, () => new Promise(() => {})); second.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(await boundedHousekeeping(new AbortController(), async () => "done")).toBe("done");
});
