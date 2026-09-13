#!/usr/bin/env node
// Node 24+; no dependencies, model calls, or source mutations.
import { HistoryIndex, bounded } from "../lib/history/index.ts";
import { loadConfig } from "../lib/history/config.ts";

const [command, ...args] = process.argv.slice(2);
if (!["refresh", "status", "search", "read"].includes(command)) {
  console.error("Usage: node tools/history.ts refresh|status|search QUERY|read SESSION [ENTRY]");
  process.exitCode = 2;
} else {
  const index = new HistoryIndex(loadConfig());
  try {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    const result = command === "refresh" ? await index.refresh(controller.signal) : command === "status" ? index.stats() :
      command === "search" ? index.search({ query: args.join(" ") }) : await index.read(args[0], { entry: args[1] }, controller.signal);
    console.log(bounded(result));
    process.removeListener("SIGINT", stop);
  } finally { index.close(); }
}
