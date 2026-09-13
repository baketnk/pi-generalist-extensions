# Portable memory store prototype

Implemented: a **bounded, harness-independent foundation**, not the complete
[memory proposal](memory-proposal.md) or a live memory extension. No existing
OptMem behavior, personality configuration or workpad attachment changes.

The intended boundary is **workpad inside the active session; memory outside
it**. This implementation does not promote workpad contents or ingest history.
It imports no Pi SDK, invokes no model, starts no worker, and has no default
storage location. Tests use disposable synthetic data. Human-operated migration
now supports an explicitly selected offline OptMem snapshot; see
[migration and cutover status](memory-migration.md). No live import has been run.

## Available now

- Explicit project/personal UUID scopes; no implicit global bucket. `unassigned`
  is a candidate-only review inbox, not an automatically recalled scope.
- Facts, threads and reflective originals, with caller-declared authorship.
  Imported summaries are separate `artifact` records that cannot be accepted.
- Candidate/accepted/retracted states. Acceptance is admission, not verification.
- Immutable logical revisions, expected-revision checks and operation UUIDs for
  identical retries. Kind, author and legacy source identity cannot change.
  The only scope change allowed is unassigned candidate → scoped candidate;
  acceptance requires a separate explicit revision.
- Retained source excerpts with byte hashes. **Provenance is caller-declared**;
  no transcript-origin binding, quote entailment or user-author authentication.
- Scope-first, AND-of-substrings lookup over current titles/bodies, returning
  bounded metadata pages. Candidates require explicit inclusion; retractions
  and superseded revisions never appear in ordinary search. Empty/punctuation
  queries return nothing. Search is not FTS or semantic recall.
- Explicit reads of current or historical revisions, including retracted ones.
- Versioned, checksummed export, empty-root restore, and same-store merge with
  full validation before atomic publication. Dry-run import is the default.
- A read-only standalone inspection CLI, plus a separate human-operated migration,
  candidate review/classification/acceptance and confirmed purge CLI.
- Purge removes a record's revisions and retained sources; minimal ID/operation
  tombstones prevent old snapshots or retries from resurrecting it.

## Library example

Use a disposable directory while evaluating this prototype:

```ts
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./lib/memory/store.ts";

const root = mkdtempSync(join(tmpdir(), "memory-fixture-"));
const store = new MemoryStore(root); // requires an existing absolute real directory
store.initialize();
const scope = `project:${randomUUID()}` as const;
const operation = randomUUID(); // keep and reuse for an identical retry
const row = store.note({
  scope, kind: "fact", title: "Fixture decision", body: "Synthetic original text.",
  author: "assistant", status: "accepted", sources: [],
}, operation);
store.search("fixture", [scope]);
store.read(row.id, [scope]);
const exported = store.export();
```

There is intentionally no model-facing tool yet. Callers control the allowed
scopes; passing a scope is not an ACL or proof of human approval. New notes
labelled `import` must be candidates. Backup restore preserves original statuses
and authorship rather than pretending to be a fresh capture. Separate stores
cannot be merged: restore into an empty root, or await a reviewed migration API.

`revise(id, expectedRevision, fullNote, reason, operation)` publishes a successor.
Imported candidates can be explicitly accepted through revision. A retry returns
the original operation's revision even if later revisions exist; use `read` for
current state. Retraction hides, but does not delete, originals. `purge` is a
separate confirmed operation; see the migration guide for scope and limitations.

## Standalone inspection

```sh
bun tools/memory-inspect.ts validate /absolute/path/export.json
bun tools/memory-inspect.ts export /absolute/store/root > /chosen/export.json
bun tools/memory-inspect.ts search /absolute/store/root project:UUID 'fixture'
bun tools/memory-inspect.ts read /absolute/store/root project:UUID RECORD_UUID
```

`validate` works on the portable export alone, without Pi or the original store.
Export prints the complete bounded transfer; choose a private destination and
permissions. CLI reads default to accepted search results and latest originals.
Library search supports offset/limit and candidate inclusion; historical reads
are also library-only for now.

## Storage and failure contract

This first slice deliberately uses **one atomic `store.json` snapshot**, not the
proposal's eventual per-record directory/index layout. Revisions inside it are
immutable by API contract; the containing file is rewritten. There is no index
to reconcile. The prototype format is explicitly named and versioned; it is not
a promise that future scalable storage will use this layout. Current snapshot
schema is version 2; version 1 remains readable and upgrades on explicit writes
or restore, preserving original revisions. The transfer envelope remains version 1.
Old readers cannot read v2 snapshots. Reads never rewrite a v1 store.

Limits: 8,192 total revisions, 16 MiB canonical store, 8 KiB UTF-8 note bodies,
32 KiB complete revisions, up to eight retained sources of 8 KiB each. Bounds
include JSON escaping where applicable. Hitting a quota refuses writes; no
originals are pruned. Search returns at most 20 metadata entries, not bodies;
individual original reads remain bounded by the revision cap. Tombstones have
an additional 8,192-operation bound and count toward the same byte cap. This is
larger migration capacity, not scalable indexed storage or a lookup-latency claim.

Canonical JSON sorts object keys, preserves array order, uses UTF-8 and has no
trailing newline. SHA-256 covers canonical snapshot bytes and exact UTF-8 source
excerpt bytes. Integrity hashes are **not signatures or truth checks**.

Writers acquire an atomic `.writer-lock` directory, fail immediately on contention,
validate the complete next snapshot, write/fsync a private temporary file, rename
it over the store, then fsync the root. Reads observe a whole old or new snapshot.
Temporary files are 0600 and locks 0700; callers must create a private root.
Symlink path components and nonregular/oversized store files are rejected.
This is local-filesystem defense in depth, not protection against a malicious
same-account process swapping paths concurrently, nor a network-filesystem claim.

An interrupted writer may leave a lock and `.pending-*` file. Neither is adopted
or removed automatically. Reads can continue if `store.json` is intact; writes
fail closed. **Only after independently establishing no writer is alive**, a
human may remove the stale lock and orphan temporary file. Do not infer this
from age or a remembered PID. Missing or corrupt canonical data fails explicitly;
there is no guessed recovery or fallback to a temporary file.

If failure occurs after rename, publication can have happened even though the
call throws (for example directory fsync fails). Retry with the same operation
UUID, then inspect current state. A successful return follows fsync; this is not
a comprehensive hardware/power-loss guarantee. Directory fsync and rename
semantics are currently exercised only on local Linux; unsupported platforms
must fail explicitly rather than silently claim durability.

## Validation and next boundary

`bun test tests/memory.test.ts` exercises revision/CAS/idempotency rules, two real
concurrent Bun processes, scope isolation, corrections/retractions, retained
original round-trips, transfer conflicts, quotas, malformed input, symlink refusal,
interrupted-lock/orphan-file fixtures, injected directory-flush failure (including
retry acknowledgement), and the standalone CLI. These are not Pi
lifecycle tests or a physical power-loss/crash campaign.

Still required before a live memory feature:

- Host-bound source provenance, approved source registration and external-source
  changed/missing states; inference/candidate policy and human-controlled core.
- Dependency invalidation when indexes/workers are added. Confirmed purge already
  covers canonical originals, but cannot erase old exports or external copies.
- Stable project alias configuration, scoped FTS, recall budgets and inspectable
  context packets.
- Pi activation/off/branch/compaction contracts and independently loaded entrypoint.
- Scalable storage/reconciliation and stronger fault-injection/platform coverage.
- Optional worker/provider controls and a reviewed live migration/cutover. Offline
  legacy snapshot tooling is implemented separately; activation is not.

This is a **partial first implementation slice**, not completion of the proposal's
portable-store acceptance gate. No live store, diary import or backend switch is
created by installing these files.
