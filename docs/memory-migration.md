# OptMem migration: offline import and review

Status: **implemented and fixture-tested offline tooling; not a live native Pi
backend or a completed cutover**. The agreed initial destination is the
**unassigned review inbox**, not personal/global automatic recall. OptMem remains
unchanged until an explicitly reviewed backend switch.

## Implemented

- Read-only compatibility reader for OptMem's fixed-width UTF-8 layout:
  `LOG.txt` uses 320-byte records, `TREE/<power-of-two-size>` uses 288-byte records.
- Raw note identity, original day (not a fabricated precise timestamp), text,
  complete padded record bytes and hashes survive import/export.
- Existing summaries are labelled artifacts with unknown creation time and
  unknown original authorship, never replacements for originals or accepted facts.
- Dry-run reports contain counts, byte estimates, digest, duplicate-text counts,
  unassigned count, and missing/blank summary coverage; no note bodies by default.
- Atomic candidate batch import, source-identity conflict detection, exact retry
  handling, candidate listing, explicit classification and separate acceptance.
- Confirmed purge with minimal ID/operation tombstones; no automatic resurrection
  when the same archive is imported again or an old operation is retried.
- No model calls, embeddings, OptMem execution, compression, environment/home
  discovery, transcript scanning, private config copying, or live backend changes.

The adapter was written from an inspection of OptMem's storage format in its
installed executable source. It does not copy the upstream compression algorithm
or invoke `memo`. This is compatibility work, not a no-exposure clean-room claim.
Format reference: [VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem).

## Before using real data

1. Explicitly select the real OptMem source and arrange an **inactive filesystem
   snapshot/copy** outside this repository. Stop all writers while creating it,
   or use a coherent filesystem snapshot. Do not copy a live log/tree piecemeal
   and assume it is consistent. This CLI neither takes OptMem's lock nor freezes
   writers. It rechecks selected bytes/inventories but cannot establish a globally
   atomic source snapshot under adversarial or ongoing changes.
2. Keep the original OptMem store untouched for rollback. Do not invoke wake/nap,
   forget, or repair just to satisfy the importer.
3. Choose a private, existing target directory outside the repository (0700),
   disjoint from the source. No default destination is inferred. Do not use a
   directory containing other data as the migration target.
4. Assign one archive UUID and keep it for subsequent snapshots of that same
   archive. Never reuse it for a different store. IDs are deterministic from
   archive UUID and fixed-width locator, not from local absolute paths or dates.
5. Inspect reports, then explicitly approve the matching digest. All source text
   is potentially private: exports and explicit `read` output contain originals.

Synthetic example placeholders below are **not real paths or IDs**:

```sh
bun tools/memory-migrate.ts inspect /private/optmem-snapshot ARCHIVE_UUID
bun tools/memory-migrate.ts import /private/optmem-snapshot ARCHIVE_UUID /private/native-store
# After reviewing the report, use its exact digest:
bun tools/memory-migrate.ts import /private/optmem-snapshot ARCHIVE_UUID /private/native-store --apply DIGEST
```

`import` without `--apply DIGEST` validates source and target capacity and creates
no canonical store/revisions. It briefly takes the target's writer lock. Source
root, target root and archive UUID are explicit; it never reads `MEMORY_DIR` or
`PI_MEMORY_HOME`. Applying into an empty target initializes only the native store.
It never creates an OptMem store or changes one.

The digest binds source file bytes, archive UUID, selected scope and summary
selection. Changing any of those requires a new review. It is a checksum, not a
signature or proof of consent; `--apply` is a human-operated administrative flag,
not a security boundary against another process with filesystem access.

By default summaries are retained as artifacts. `--raw-only` explicitly excludes
them while still validating/reporting existing summary files. Optional `SCOPE`
can place an entire archive into `project:UUID` or `personal:UUID`, but does not
accept it. For a mixed archive, leave the default `unassigned` and classify each
record after review. Use the same initial scope on repeated imports: changing it
conflicts with the original capture rather than silently reclassifying records.

## Review, classify, accept

```sh
bun tools/memory-migrate.ts review /private/native-store unassigned
# Pass the returned nextOffset as a final argument for another metadata page.
bun tools/memory-inspect.ts read /private/native-store unassigned RECORD_UUID

# Choose a real project/personal UUID, then classify. The record stays candidate.
bun tools/memory-migrate.ts classify /private/native-store RECORD_UUID 1 project:PROJECT_UUID OPERATION_UUID --apply
# Read the classified original before accepting it as useful durable information.
bun tools/memory-inspect.ts read /private/native-store project:PROJECT_UUID RECORD_UUID
bun tools/memory-migrate.ts accept /private/native-store project:PROJECT_UUID RECORD_UUID 2 NEW_OPERATION_UUID --apply
```

Keep operation UUIDs for exact retries; expected revisions guard against stale
reviews. Classification and acceptance are distinct operations. Acceptance means
admitted to memory, **not independently verified**. Provenance is still imported,
not recast as a user statement. Raw OptMem notes may include outdated or false
claims; preserving originals does not validate them. Artifacts cannot be accepted
or turned into facts by changing their kind. A later separately authored decision
may cite an artifact, but must not pretend it was an original raw note.

Candidate/accepted/retracted state remains available through the library.
`memory-inspect.ts search` retrieves accepted current records only. Candidate
listing is explicit, and there is no automatic recall or conversation injection.
The model has no migration, acceptance, archive-registration or purge tool.

## Purge versus retraction

Retraction keeps history; purge removes all revisions and retained source text
owned by that record from the canonical store:

```sh
bun tools/memory-migrate.ts purge /private/native-store project:PROJECT_UUID RECORD_UUID
# Review the preview and warnings, then confirm the exact ID and current revision:
bun tools/memory-migrate.ts purge /private/native-store project:PROJECT_UUID RECORD_UUID 3 --confirm purge:RECORD_UUID
```

Minimal record ID/operation tombstones remain, not titles, bodies, excerpts or
source paths. Reimporting an OptMem archive reports `skippedPurged` for those source
identities. Backup import fails on tombstone/record conflicts rather than deleting
live local records or restoring purged ones. Tombstones themselves round-trip.
A deliberately new archive identity can reintroduce the same external text; the
store is not a content filter or secure-erasure system.

Purge cannot erase original OptMem data, other records that quote the same text,
prior exports, already-published session excerpts, orphan temporary files from
interrupted writes, filesystem snapshots or backups. No secure disk-erasure claim.
There are no native derived indexes or worker payloads yet; future implementations
must explicitly add their invalidation/deletion before reusing this contract.

## Supported bounds and failure behavior

- At most 4,096 raw records per selected snapshot and their existing tree levels.
  The native prototype now supports 8,192 revisions and a 16 MiB canonical store.
  Imports near that bound leave little revision headroom; the target dry-run checks
  actual size/quota. It refuses excess rather than importing only an unnoticed
  prefix. A larger archive needs the scalable-store milestone, not silent pruning.
- `LOG.txt` is mandatory; missing `TREE` is reported as unknown summary coverage.
  Existing blank summaries are counted, not turned into invented content.
  Missing/blank compressions never block valid raw import or trigger a worker.
- `config` and `.lock` are ignored and not read. Unknown filenames/layouts fail
  explicitly. There is no generic recursive source importer.
- Partial records, invalid UTF-8, invalid dates/positions, oversized files, illegal
  tree levels and symlinks are rejected without truncation, repair or publication.
  Failure messages identify structural locators, not memory bodies.
- Duplicate text at different original positions is counted and retained. Changed
  bytes at an already imported identity are a conflict; no overwrite. Appended raw
  records retain old identities and add only new candidates. Reviewed successors
  remain current on repeat imports.
- All selected candidates publish through one native store lock/snapshot rename.
  An invalid item/conflict/quota error publishes none of the batch. An I/O failure
  after rename may be uncertain: inspect and retry with the same archive identity.
  See [store failure contract](memory-store.md) for lock and fsync limitations.
- Snapshot schema v2 adds migration provenance, day/unknown source-time precision,
  unassigned/artifact kinds and purge tombstones. Original v1 stores remain readable
  and upgrade on explicit writes/restore; original revision contents are preserved.

## Validation and remaining cutover gates

`bun test tests/memory.test.ts tests/memory-migration.test.ts` covers synthetic
fixed-width originals/summaries, a 1,024-raw-record archive, the full supported
4,096-raw/4,095-summary boundary, multibyte byte offsets,
missing/blank summaries, malformed input, conflict/append retries, separate scope
classification/acceptance, purge/reimport behavior, old-schema upgrades and CLI
approval/digest handling. A real subprocess export test checks large piped output
is complete. No private archive fixture is stored in the repository.

**Still needed before calling this an OptMem replacement inside Pi:**

1. A native extension with explicit profile/project mapping and host-bound capture
   provenance; no arbitrary transcript paths or model-supplied user authorship.
2. Scoped FTS/retrieval budgets and inspectable selection packets, with no whole
   archive lookup/serialization on each prompt. The bounded snapshot store is
   adequate for offline staging, not the final prompt-path storage architecture.
3. Tested activation/off/reload/resume/fork/tree/compaction behavior and a single
   writable-backend guard. Turning native memory on must disable the OptMem tool,
   wake guidance and hidden reminder together, not silently reinterpret old flags.
4. A read-only comparison on an explicitly approved real snapshot, review of
   candidates, then a human-approved switch with the old files retained for rollback.

A separate indexing model can follow; it is **not required** to escape OptMem's
foreground wake/nap loop. No migration, personality activation, provider consent,
or backend switch is implied by installing or pushing this code.
