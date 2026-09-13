import { readReceipt, verifyReceipt } from "../lib/bg-tasks/receipt.ts";

const [action, path, expected, ...extra] = process.argv.slice(2);
try {
  if (!path || extra.length || (action !== "read" && action !== "check") || (action === "read" && expected))
    throw new Error("Usage: bun tools/execution-receipt.ts read PATH | check PATH [EXPECTED_RECEIPT_SHA256]");
  const result = action === "read" ? await readReceipt(path) : await verifyReceipt(path, expected);
  console.log(JSON.stringify(result, null, 2));
  if ("artifactIntegrity" in result && (result.artifactIntegrity !== "match" || result.receiptIntegrity === "changed")) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
