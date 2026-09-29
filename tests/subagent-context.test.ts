import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { boundToolResult, CLIPPED_TOOL_OUTPUT } from "../lib/subagents/context.ts";
import { estimateTokens } from "../lib/subagents/snapshot.ts";

const result = (text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: "fixture-call", toolName: "read",
  content: [{ type: "text", text }], isError: false, timestamp: 1 });

test("new result bounding preserves untouched results and does not mutate clipped originals", () => {
  const small = result("evidence");
  expect(boundToolResult(small, 1000)).toBe(small);
  for (const text of ["evidence ".repeat(10000), "\u0001".repeat(50000), "🦝界".repeat(10000)]) {
    const original = { ...result(text), isError: true, details: { original: "metadata" } };
    const saved = structuredClone(original);
    const bounded = boundToolResult(original, 500);
    expect(original).toEqual(saved);
    expect(bounded.isError).toBe(true);
    expect(bounded.toolCallId).toBe(original.toolCallId);
    expect(estimateTokens(bounded)).toBeLessThanOrEqual(500);
    expect(bounded.content[0]).toMatchObject({ type: "text" });
    expect((bounded.content[0] as { text: string }).text).toEndWith(CLIPPED_TOOL_OUTPUT);
    expect((bounded.content[0] as { text: string }).text).not.toMatch(/[\uD800-\uDBFF]\n/);
  }
});

test("image cost ignores base64 size; omitted images and oversized metadata are explicitly clipped", () => {
  const original = result("caption");
  original.content.push({ type: "image", mimeType: "image/png", data: "A".repeat(300000) });
  expect(boundToolResult(original, 3000)).toBe(original);
  const bounded = boundToolResult(original, 500);
  expect(estimateTokens(bounded)).toBeLessThanOrEqual(500);
  expect(bounded.content).toEqual([{ type: "text", text: "caption" + CLIPPED_TOOL_OUTPUT }]);
  expect(original.content).toHaveLength(2);
  expect(estimateTokens(boundToolResult({ ...result("ok"), details: { diff: "x".repeat(100000) } }, 500))).toBeLessThanOrEqual(500);
});
