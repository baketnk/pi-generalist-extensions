import { decodeTransfer, scope, STORE_BYTES, type Scope } from "../lib/memory/schema.ts";
import { boundedFile, MemoryStore } from "../lib/memory/store.ts";

// Standalone inspection only: no Pi imports, implicit home, writes or provider calls.
const [command, path, ...args] = process.argv.slice(2);
try {
  if (!path) throw new Error("Missing explicit file/store path");
  let result: unknown, serialized: string | undefined;
  if (command === "validate" && args.length === 0) {
    const snapshot = decodeTransfer(boundedFile(path, STORE_BYTES + 1024));
    result = { valid: true, storeId: snapshot.storeId, revisions: snapshot.revisions.length,
      provenance: "Caller-declared; hashes establish retained-byte integrity, not authenticity or truth." };
  } else if (command === "export" && args.length === 0) {
    serialized = new MemoryStore(path).export();
  } else if (command === "search" && args.length === 2) {
    scope(args[0]);
    result = new MemoryStore(path).search(args[1], [args[0] as Scope]);
  } else if (command === "read" && args.length === 2) {
    scope(args[0]);
    result = new MemoryStore(path).read(args[1], [args[0] as Scope]);
  } else throw new Error("Invalid command or arguments");
  console.log(serialized ?? JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\nUsage: bun tools/memory-inspect.ts validate TRANSFER_FILE | export ABSOLUTE_STORE_ROOT | search ABSOLUTE_STORE_ROOT SCOPE QUERY | read ABSOLUTE_STORE_ROOT SCOPE UUID`);
  process.exitCode = 1;
}
