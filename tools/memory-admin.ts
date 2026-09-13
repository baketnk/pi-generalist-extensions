import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/memory/store.ts";

// Explicit native initialization, never implicit discovery or legacy archive execution.
const [action, root, confirmationFlag, confirmation, ...extra] = process.argv.slice(2);
try {
  if (action !== "init" || !root || confirmationFlag !== "--confirm" || confirmation !== "init-native-memory" || extra.length) throw new Error("Explicit native initialization confirmation required");
  const store = new MemoryStore(root);
  if (!existsSync(join(store.root, "store.json")) && readdirSync(store.root).length) throw new Error("New native stores require an empty directory; never initialize inside a legacy archive");
  console.log(JSON.stringify({ storeId: store.initialize() }));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : "Native initialization failed"}\nUsage: bun tools/memory-admin.ts init ABSOLUTE_EMPTY_DIRECTORY --confirm init-native-memory`);
  process.exitCode = 1;
}
