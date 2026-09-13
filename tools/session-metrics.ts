import { readSessionMetrics } from "../lib/session-metrics.ts";

try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Usage: bun tools/session-metrics.ts SESSION.jsonl");
  console.log(JSON.stringify(await readSessionMetrics(path), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
