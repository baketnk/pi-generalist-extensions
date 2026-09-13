import { isAbsolute, relative, resolve, sep } from "node:path";
import { inspectOptmemSnapshot } from "../lib/memory/legacy-optmem.ts";
import { id, scope, type Note, type Revision, type Scope } from "../lib/memory/schema.ts";
import { MemoryStore } from "../lib/memory/store.ts";

// Human-operated, offline administration. Never registered as a model tool.
const usage = `Usage:
  bun tools/memory-migrate.ts inspect SNAPSHOT_ROOT ARCHIVE_UUID [SCOPE] [--raw-only]
  bun tools/memory-migrate.ts import SNAPSHOT_ROOT ARCHIVE_UUID TARGET_ROOT [SCOPE] [--raw-only] [--apply DIGEST]
  bun tools/memory-migrate.ts review TARGET_ROOT SCOPE [OFFSET]
  bun tools/memory-migrate.ts classify TARGET_ROOT ID EXPECTED_REVISION SCOPE OPERATION_UUID --apply
  bun tools/memory-migrate.ts accept TARGET_ROOT SCOPE ID EXPECTED_REVISION OPERATION_UUID --apply
  bun tools/memory-migrate.ts purge TARGET_ROOT SCOPE ID [EXPECTED_REVISION --confirm purge:ID]
All roots must be explicit absolute directories. Import defaults to dry-run and unassigned candidates.
Apply requires the exact digest printed by inspection/dry-run. Use an inactive snapshot, never a live OptMem directory.`;
function plainNote(row: Revision): Note {
  const { id: _id, revision: _rev, createdAt: _time, reason: _reason, operation: _op, ...note } = row;
  return note;
}
function separateRoots(source: string, target: string) {
  if (![source, target].every(isAbsolute)) throw new Error("Explicit absolute roots required");
  const inside = (a: string, b: string) => { const r = relative(resolve(a), resolve(b)); return !r || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  if (inside(source, target) || inside(target, source)) throw new Error("Snapshot and target roots must not overlap");
}
try {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "inspect" || command === "import") {
    const base = command === "inspect" ? 2 : 3;
    if (args.length < base) throw new Error("Missing required arguments");
    const [source, archiveId, target] = args, options = args.slice(base);
    let targetScope: Scope = "unassigned", includeSummaries = true, apply: string | undefined, assigned = false, rawOnly = false;
    for (let i = 0; i < options.length; i++) {
      const value = options[i];
      if (value === "--raw-only" && !rawOnly) { includeSummaries = false; rawOnly = true; }
      else if (value === "--apply" && command === "import" && apply === undefined) {
        apply = options[++i];
        if (!apply || apply.length !== 64 || !/^[a-f0-9]+$/.test(apply)) throw new Error("Apply requires a snapshot digest");
      } else if (!assigned && !value.startsWith("--")) { scope(value); targetScope = value; assigned = true; }
      else throw new Error("Unexpected or repeated argument");
    }
    const plan = inspectOptmemSnapshot(source, { archiveId, targetScope, includeSummaries });
    if (command === "inspect") result = plan.report;
    else {
      separateRoots(source, target);
      if (apply !== undefined && apply !== plan.report.digest) throw new Error("Snapshot/selection digest changed; inspect again before applying");
      const destination = new MemoryStore(target);
      const transfer = destination.importNotes(plan.entries, apply === undefined);
      result = { ...plan.report, transfer, warning: "OptMem was not invoked or changed. Candidates are not active memory; no backend switch occurred." };
    }
  } else if (command === "review" && (args.length === 2 || args.length === 3)) {
    scope(args[1]);
    result = new MemoryStore(args[0]).list([args[1]], { offset: args[2] === undefined ? 0 : Number(args[2]) });
  } else if (command === "classify" && args.length === 6 && args[5] === "--apply") {
    const [root, recordId, expected, targetScope, operation] = args;
    scope(targetScope); id(operation);
    if (targetScope === "unassigned") throw new Error("Choose a project/personal scope");
    const store = new MemoryStore(root), original = store.read(recordId, ["unassigned"], Number(expected));
    if (original.status !== "candidate") throw new Error("Only unassigned candidates can be classified");
    const row = store.revise(recordId, Number(expected), { ...plainNote(original), scope: targetScope }, "Human scope classification", operation);
    result = { id: row.id, revision: row.revision, scope: row.scope, status: row.status };
  } else if (command === "accept" && args.length === 6 && args[5] === "--apply") {
    const [root, allowedScope, recordId, expected, operation] = args;
    scope(allowedScope); id(operation);
    const store = new MemoryStore(root), original = store.read(recordId, [allowedScope], Number(expected));
    if (original.status !== "candidate" || original.kind === "artifact" || original.scope === "unassigned") throw new Error("Only classified non-artifact candidates may be accepted");
    const row = store.revise(recordId, Number(expected), { ...plainNote(original), status: "accepted" }, "Human candidate acceptance (not independent verification)", operation);
    result = { id: row.id, revision: row.revision, scope: row.scope, status: row.status };
  } else if (command === "purge" && (args.length === 3 || (args.length === 6 && args[4] === "--confirm"))) {
    const [root, allowedScope, recordId, expected, _confirm, confirmation] = args;
    scope(allowedScope);
    const store = new MemoryStore(root);
    // Read enforces the selected scope before either preview or administration.
    const original = store.read(recordId, [allowedScope]);
    const warning = "Purge removes all revisions and retained sources for this record from the canonical store. IDs/operation tombstones remain. It cannot erase the OptMem snapshot, other records quoting the same text, prior exports, session excerpts, orphan temporaries, filesystem snapshots, or backups; no secure-erasure guarantee.";
    result = args.length === 3
      ? { id: original.id, revision: original.revision, dryRun: true, confirmation: `purge:${recordId}`, warning }
      : { ...store.purge(recordId, Number(expected), confirmation), warning };
  } else throw new Error("Invalid command or arguments");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  process.exitCode = 1;
}
