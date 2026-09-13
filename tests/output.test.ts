import { expect, test } from "bun:test";
import { formatOutput, OUTPUT_CONFIG_ENTRY } from "../lib/output.ts";

const context = (entries: any[]) => ({ sessionManager: { getBranch: () => entries } } as any);

test("output is readable by default and branch-local raw JSON is opt-in", () => {
  const value = { storeId: "abc", items: [{ title: "One", active: true }] };
  expect(formatOutput(value, context([]))).toBe("store Id: abc\nitems:\n  - title: One\n    active: true");
  const entries = [{ type: "custom", customType: OUTPUT_CONFIG_ENTRY, data: { rawJson: true } }];
  expect(formatOutput(value, context(entries))).toBe(JSON.stringify(value, null, 2));
});
