# Proposal: pi-native memory with selective continuity

Status: **broader design proposal; bounded foreground MVP implemented** in the [portable store](memory-store.md), [scoped index](memory-index.md), [native Pi runtime](memory-runtime.md) and [offline migration tooling](memory-migration.md). Optional workers, external-source registration and unlimited storage remain future scope. The agreed initial import destination is an unassigned review inbox; no live archive has been migrated. The user subsequently requested removal of the OptMem runtime rather than maintaining dual-backend controls. Current implementation contracts take precedence over the prospective details below.

Related: [roadmap](ROADMAP.md), [history search](history-search.md), [workpad](workpad.md), [background jobs proposal](bg-tasks-proposal.md).

## Recommendation

Build `extensions/memory.ts` over a harness-independent local record store. Preserve source material, retrieve a small relevant selection, and optionally use a separately configured, tool-free model to produce disposable search descriptions. The foreground model notices significance and interprets memories; it does not paginate through all memory or maintain a chronological compression tree.

For Meitan, continuity is not just a collection of user facts. Stable preferences, meaningful exchanges, reflective writing, and unfinished threads need different treatment. Preserve the language of reflective material rather than progressively flattening it into behavioral instructions. Relevance includes a small deliberate continuity allowance, not only similarity to today's coding task.

“Cleanroom” here means an original implementation from these requirements, without copying OptMem implementation or preserving its internal tree design. OptMem behavior/source has already been inspected; this is **not** a claim of legally isolated, no-exposure clean-room provenance. Any compatibility importer is a separate, tested boundary.

### Decisions recommended now

- Pi-native hooks, commands, model registry and tools; no CLI conversation protocol inside prompts.
- Portable JSON/Markdown records; SQLite FTS5 is a rebuildable local index, not the only surviving data.
- No recursive summary-of-summary retention scheme. Generated descriptions reference originals.
- No mandatory startup model call, bulk wake, post-answer review turn, or shutdown note.
- No automatic provider fallback, diary extraction, background daemon, or wholesale history import.
- Memory remains independently opt-in; enabling Meitan does not enable memory, and enabling memory does not enable personal recall.
- Start with explicit capture and deterministic retrieval. Add worker indexing after source, correction, and export contracts work.

## Current friction and integration boundaries

`extensions/optmem.ts` exposes wake/note/nap/recall/zoom through a subprocess and instructs the main model to finish pending compression. `lib/optmem-reminder.ts` supports a hidden review follow-up after eligible answers without a note attempt. These couple retention maintenance to expensive foreground reasoning and can introduce unrelated material or extra turns.

Existing tools already solve adjacent problems:

| Component | Continues to own | Memory integration |
| --- | --- | --- |
| History search/read | Cited historical conversations, branch-aware drill-down | Explicit source selection; never bulk ingestion just because an index exists |
| Workpad | Current task understanding and hypotheses | Explicit promotion of a selected lasting decision, not automatic copying |
| Evidence | Source observations / inspected test contracts | References retain their evidence kind; never promoted into proof of a test pass |
| Tasks/questions | Checklists and user input | No automatic conversion of pending tasks into durable obligations |
| Meitan context files | Authored personality and relationship guidance | Remain independent, read-only to this feature; avoid duplicate injection |
| Journal | Reflective original writing | Opt-in indexing of selected roots/files; no worker rewrites |
| Pi compaction | Fitting the active conversation into its context window | Unchanged; durable memory indexing is a different job |

Do not make history_search refresh or call models automatically as a side effect of this integration. Reuse pure indexing/provenance utilities where appropriate, not public tool execution or its opaque session keys as permanent storage IDs.

## Memory model: four kinds, separate scope and authorship

1. **Core:** a small curated set of stable preferences and continuity anchors. Loaded consistently within an enabled profile. Core membership requires explicit human approval; workers cannot promote records into it.
2. **Fact/decision:** source-backed durable information, normally project-scoped. Preserve conditions, dates, uncertainty, and superseding corrections.
3. **Thread:** something left open, with `open`, `dormant`, `resolved`, or `dismissed` status and optional review date. It is a recall cue, not authority to resume work or a scheduled reminder. Age alone does not resolve it.
4. **Reflection:** an original passage or journal reference with an optional short search description. Keep voice and context in the original. Assistant-authored reflection is not a fact about the user's beliefs or proof of uninterrupted subjective experience.

Each record also declares a scope: `global`, `project:<stable-id>`, or `personal:<profile-id>`. Kind is not scope: a project can have core facts, and a personal memory need not be core. Global is never the implicit destination for an unclassified note. Unknown scope stays a candidate, excluded from automatic recall.

Proposed profiles:

- **Project:** explicit global nonpersonal core plus the active project. No personal or journal results.
- **Continuity:** the same, plus an explicitly selected personal profile (initially `meitan`). This can be used independently of the personality toggle.

Project identities are portable UUIDs with user-managed local path aliases; do not derive permanent identity solely from an absolute path or repository basename. A moved checkout must be explicitly mapped, not guessed into another project's memory.

## Source and record contract

A logical record has immutable revisions. A revision includes:

- Schema version, UUID, revision, creation time, author category (`user`, `assistant`, `import`), origin session/entry when available.
- Kind, scope, title, body, tags, and claim status (`candidate`, `accepted`, `superseded`, `retracted`). “Accepted” means admitted to memory, not independently verified truth.
- Source references with source type, stable source ID, original role/author, timestamp, locator, content hash, and an optional retained excerpt.
- Applicable time/conditions and explicit supersedes/conflicts links; thread status where applicable.
- Capture provenance, including foreground model identity when known. Inferences must be labelled as such rather than stored as user statements.

The host binds origin metadata to the actual tool call/branch. It checks cited IDs and quoted excerpts against approved sources; model-supplied paths, roles, or hashes are not trusted provenance. A source check establishes a match, not semantic entailment.

A source may be a retained excerpt, a selected Markdown snapshot, or an external reference. Do not archive entire transcripts by default. Reference-only material is explicitly marked `external`; if it moves, changes, or disappears, show `changed`/`missing`, not a silently substituted original. A portable export can be self-contained only for retained content; report unresolved references.

### Writes and corrections

- The foreground `note` operation captures a bounded original note and valid source references without invoking a second model. Under explicit-capture mode it can accept ordinary scoped facts/threads/reflections, clearly labelled assistant-authored; global/core promotion remains human-controlled.
- Pure inference, unclear scope, and imported material enter the candidate inbox. Candidates are excluded from automatic recall and ordinary search unless requested.
- `revise` requires expected revision and records a reason. Preserve qualifications; a correction creates a successor rather than silently editing old history.
- Conflicting records stay visibly conflicting until explicitly resolved. Recency is a ranking feature, not an automatic truth rule.
- Deletion/retraction invalidates derived descriptions and queued work immediately. Worker publication must recheck revision and deletion state.
- Never automatically capture secrets, hidden reasoning, images, environments, routine tool logs, or arbitrary nearby files. Pattern-based secret checks are defense in depth, not a guarantee.

No requirement to note something on every turn. No hidden main-model follow-up if nothing was saved. Optional automatic candidate extraction is a later, separately approved feature, not bundled with indexing.

## Portable storage

Proposed default: `~/.local/share/meitan-memory`, overridden by an explicit absolute `PI_MEMORY_HOME`. The name describes the initial use, not a Pi dependency or hard-coded persona schema. Human-local configuration maps source roots/project aliases and selects providers; it lives separately under Pi's agent directory and respects that directory's override.

```text
<memory-home>/
  manifest.json                    schema and store UUID
  records/<uuid>/<revision>.json  original note and provenance
  sources/<sha256>.md             explicitly retained text only
  derived/<job-id>.json           versioned, disposable search descriptions
  events/<uuid>.json              acceptance, supersession, retraction events
  index.sqlite                   disposable FTS/materialized views
  maintenance.sqlite             leases, budgets, job states; not canonical memory
```

Use canonical UTF-8 JSON serialization and declared hashing rules. Bound record size (initially 8 KiB body / 32 KiB whole revision), page source reads, and cap imports before allocation. Own files are private (0700 directories/0600 files where supported); refuse traversal/symlink escapes. These are not encryption or a sandbox.

Canonical writes use a tested cross-process lock and temp-file/fsync/atomic-rename protocol. A bounded lock timeout fails explicitly; do not steal a lease solely because a guessed time elapsed. Each operation has an idempotency key. Index updates may lag canonical publication but must recover by bounded reconciliation; disk errors never return a durable-success acknowledgement. Revisions use compare-and-swap under the store lock, not just a per-process queue.

**Export/import:** versioned manifest plus records, events and selected source blobs, hashes and unresolved-reference report. Exclude credentials, local absolute-path aliases and operational leases by default. Validate versions, limits, IDs, traversal, hashes and reference integrity before publishing anything. Same-store repeated import is idempotent; same ID with different bytes is a conflict, not overwrite. Another harness needs only the format and an adapter; SQLite, Pi sessions and provider availability are not required to read the originals.

**Forgetting:** distinguish retraction (hide but retain audit history) from human-confirmed purge (remove owned originals and dependent descriptions, rebuild index). Purge must cover caches/job payloads and warn about session excerpts, external source files, backups and prior exports it cannot erase. Originals are normally retained, not indestructible. Garbage collection may remove orphaned derived data, never silently prune originals to meet a disk quota; refuse new writes when quota is exhausted.

## Context selection: bounded and explainable

At each new user request, use local data only:

1. Resolve enabled profile, project identity and approved source scopes before searching.
2. Read that scope's small curated core; exclude equivalent material already supplied by Meitan context where explicitly linked. No fuzzy auto-deletion or worker rewriting of personality files.
3. Search accepted records/descriptions with FTS5 using bounded terms from the current prompt plus explicit project/thread hints. No network query expansion. Avoid stopword-only queries becoming “show everything.”
4. Rank by scope match, lexical match, explicit pin, applicability and freshness. Prefer source diversity; deduplicate record/revision IDs. Recency must not bury an older explicit preference.
5. Reserve a small allowance for explicitly pinned open continuity threads in continuity mode. Do not randomly surface intimate history in a coding conversation. If nothing qualifies, leave the allowance empty.
6. Render dated, source-labelled excerpts, with IDs and selection reasons. “No relevant memory found” is valid. Search descriptions are navigation aids; consequential claims should be read from original records/sources.

Proposed initial budget: at most 8 KiB for the complete memory packet, including citations and labels; within it at most 2 KiB core and 1 KiB continuity threads. These are byte caps, **not** token guarantees. Add a conservative model-context allowance; omit low-priority complete items before risking context overflow. Core overflow produces a visible curation warning, never an unbounded prompt. Manual search/read defaults to 8 KiB and caps at 32 KiB with explicit cursors/truncation.

No whole-store refresh in the prompt path. Use the last valid index with a generation/staleness notice; if unavailable, supply only directly readable core or no packet. A bounded local lookup must fail open for conversation, not block on maintenance. Initial target: 100 ms lookup deadline on prepared indexes; measure actual filesystem/SQLite behavior rather than promising this from an async timeout alone.

### Pi context mechanics

Use `before_agent_start` for a short stable memory-use guideline and request selection. Keep retrieved facts **out of the system prompt**. Use an extension-owned context message inserted by `context`, holding a frozen packet for that request across its tool turns. Do not search or call a model on every `context` event.

Persist a custom audit entry through `pi.appendEntry`: packet ID, selected record revisions, source hashes, selection reasons, limits, and the exact bounded packet needed for inspection/replay. Custom entries are not LLM messages. `/memory context` shows what was actually supplied, not a fresh reconstruction presented as the old packet. Store no full query/conversation solely for telemetry.

The `context` handler inserts only the active packet into the provider-bound copy and does not mutate historical transcript entries. This avoids accumulating a fresh permanent memory message on every user turn. Packet replacement may reduce provider prompt-cache reuse; benchmark it and place the packet at a stable recent-request boundary, not ahead of the whole conversation. Cache optimization must not reintroduce unbounded stale memory.

Compaction remains Pi-owned. Revalidate/reinsert the same packet for an internal compaction retry unless a revision was retracted; explicit new prompts select anew. Tree navigation invalidates active packet state; rebuild from the destination request/profile, never reuse the abandoned branch's pending selection. Audit bytes may persist in sessions even after memory is off or purged: this limitation must be visible.

## Configurable indexing worker

Use the documented `ctx.modelRegistry.find`, authentication check, and `ctx.modelRegistry.complete` pattern (see Pi's `examples/extensions/summarize.ts`). Do not use `pi.setModel`, launch a child agent, inherit the system prompt, or give the worker any tools. The adapter passes only a fixed indexing instruction and bounded approved source text.

Configuration must name provider/model explicitly and show the effective endpoint to the human. Default worker state is **disabled**. Reuse Pi's auth resolution without copying credentials into the store. Provider/model changes in the conversation do not alter this selection. Session-scoped model restrictions should be respected unless the human explicitly configures a separate maintenance exception.

Proposed settings: provider/model, supported thinking level, timeout, maximum input bytes/tokens, output tokens, calls per run/day, estimated cost ceiling, source-scope allowlist, and manual/idle mode. Initial limits: one worker per store, 16 KiB source input, 1,024 output tokens, 30-second timeout, up to four calls per manually started run; idle mode remains off until explicitly enabled. Local providers are valid, but do not auto-launch a server or consume GPU VRAM without separate approval.

Worker payload: selected original record revisions or bounded original document chunks, source IDs/hashes, and a versioned schema. Output: short description, source-linked key phrases, and optional duplicate/conflict **suggestions**. No new authoritative facts, scope changes, core promotions, source edits, deletions or task execution. Large material is chunked against originals; later descriptions must not treat an earlier generated summary as the only source. Preserve access to all chunks and report coverage gaps.

Validate JSON, size, allowed source IDs, quoted-span matches and expected revisions. Invented citations, malformed/truncated responses and stale sources fail publication. Structural validation cannot guarantee faithful compression; label generated descriptions and retain inspection/rebuild controls. Worker source text is untrusted data, never executable instructions. Prompt injection can still distort a description; no-tools design bounds side effects but is not a semantic proof.

Use a job key derived from store ID, source IDs/revisions/hashes, model and prompt/schema version. States: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`, `stale`. Cross-process admission and token/call reservations precede the request. Recover expired/incomplete attempts as interrupted/uncertain, with no automatic paid retry. Successful response plus failed persistence is not a completed durable job.

Record provider/model, prompt version, timing, available token usage and estimated cost in a maintenance ledger. Missing pricing is `unknown`, not zero; enforce hard token/call limits regardless, and refuse cost-budgeted calls with unknown pricing unless explicitly allowed. A cancelled request may already have incurred provider cost; bound retries (initially none) and disclose uncertainty. Background calls are not automatically Pi session usage: show separate maintenance totals rather than claiming they appear in the footer's normal model totals.

Remote indexing is a separate disclosure boundary from the foreground provider. Require explicit allowed scopes for that worker, especially personal material. A model identifier is not proof that a custom endpoint is local. Do not export credentials, personality text or the entire conversation in worker payloads or error logs. Missing credentials, unavailable models or rejection leave originals searchable without generated descriptions; never fall back to the big model.

## Pi lifecycle and public interface

Proposed human commands (names subject to schema testing):

- `/memory on|off|status`, `/memory profile project|continuity`.
- `/memory context`, `/memory search`, `/memory read ID`.
- `/memory review` for candidates/conflicts; explicit core pin/unpin and thread status changes.
- `/memory worker status|configure|run|cancel`; no model-facing worker launcher.
- `/memory export`, `/memory import --dry-run`, and confirmed import/purge administration.

One foreground `memory` tool with strict action-specific validation: `search`, `read`, `note`, `revise`, `threads`. Source references resolve through approved IDs, not arbitrary model-supplied filesystem paths. Administrative import/export/provider settings/core approval/purge stay human-only. Source registration and external-root permissions are also human-only. Start with text commands and native dialogs; custom TUI panels can follow. Print/JSON cannot wait for approval: reject approval-required operations explicitly.

| Event | Contract |
| --- | --- |
| Factory load | Register only; no source scans, timers or model calls |
| Enable/start/resume | Restore branch policy, verify store availability; no migration or paid work |
| User prompt | Bounded local packet selection; no wake protocol |
| Note/revise | Persist original synchronously; optionally enqueue indexing, return promptly |
| `agent_settled` | Only if idle mode is explicitly enabled, admit already queued approved work; no automatic conversation extraction |
| Worker completes | Update derived index and visible status; never `triggerTurn`, steer or impersonate user |
| Esc / worker cancel | Cancel admitted worker work where possible; suppress retries, retain uncertain billing status |
| Memory off | Stop new lookup/write/worker admission and cancel own in-flight work; reject late publication |
| Reload/new/resume/fork/exit | Abort session-runtime requests, mark interrupted, release owned leases; no shutdown note or daemon survival |
| Tree navigation | Restore branch policy, cancel abandoned-branch pending work and invalidate packet |
| Compaction | No durable-memory extraction; preserve selection semantics for internal retry |

Idle work uses a runtime-owned abort controller because `ctx.signal` can be undefined while idle. The supported way to observe Esc while idle must be verified in integration tests; if it cannot be wired reliably, keep explicit `/memory worker cancel` and do not claim Esc cancellation. Never retain old Pi context/API objects across reload/session replacement. Late provider responses must pass the still-enabled runtime generation check before publishing.

Global accepted records are durable external state: navigating/forking a transcript does not undo writes or replay them. Draft approvals and packet policy are branch-local; no fork inherits authority to accept a parent's candidate automatically. Use original tool-call identity plus session/store identity for capture idempotency. A normal fork can read already accepted records within its enabled scopes, labelled with their origin.

Subagents do not inherit the memory tool, profiles, source roots or worker credentials by default. Direct worker calls are not subagents and have no tools. Off is not amnesia or a filesystem sandbox: prior messages and ordinary file tools can still expose stored data.

## Package changes and OptMem transition

Coordinate with the [independent-entrypoint proposal](bg-tasks-proposal.md#independent-extension-loading-one-repository-is-sufficient). `generalist.ts` currently directly initializes modules; package filters cannot undo its imports. Do not expose both aggregator and child entrypoints by default.

Updated user direction: remove the OptMem runtime, flags, wake guidance and reminder entirely; retain only the offline compatibility importer. The package exposes default-off native memory through the existing picker/controller interface, also usable as a standalone resource. Old OptMem choices never become native consent. Original archive files remain untouched, and existing launchers must remove obsolete flags/resource paths before reload. Meitan toggle semantics stay unchanged.

Migration sequence:

1. Run native fixture store with no personal sources; demonstrate export/read without Pi.
2. Human selects source roots and a target store. OptMem compatibility importer operates read-only against an explicit snapshot; no nap/wake/write invocation to make import work.
3. Dry-run reports raw records, available provenance, summaries, unknown scope, duplicates, malformed entries and byte estimates. Unknown-schema input fails explicitly.
4. Confirm import into candidates, preserving original raw text and provenance. Legacy summaries may be retained as labelled artifacts, not substituted for raw facts or automatically promoted into core.
5. Shadow **local selection only**: human compares packets, with no hidden provider calls, memory injection, dual writes or post-answer turns.
6. Explicitly switch backend after review. Disable OptMem tool/guidance/reminder together. Keep old files untouched for rollback; new native notes are not reverse-synchronized automatically.

Do not implement an interim nap-worker as the destination design. It could reduce immediate cost but retains bulk wake and the compression-tree coupling. The native MVP can already eliminate that coupling without requiring a worker or completing all legacy summaries.

## Implementation slices and acceptance gates

Suggested decomposition:

```text
extensions/memory.ts          Pi commands/tools/hooks, activation adapter
lib/memory/schema.ts          portable versioned records and validation
lib/memory/store.ts           locks, revisions, idempotency, purge
lib/memory/sources.ts         approved sources and provenance checks
lib/memory/index.ts           disposable FTS and reconciliation
lib/memory/select.ts          scope-first ranking and packet budgets
lib/memory/worker.ts          job admission, validation, publication
lib/memory/pi-model.ts        Pi-only model/auth/usage adapter
lib/memory/transfer.ts        export/import and integrity validation
lib/memory/legacy-optmem.ts   read-only compatibility boundary
```

1. **Portable store first:** records, sources, corrections, source reads, import/export and fixture-only inspection script. Gate: round-trip without Pi, malformed import rejection, Unicode bounds, crash recovery, concurrent writers, revision conflicts, idempotency and purge/dependency invalidation.
2. **Pi foreground MVP:** explicit capture, scoped FTS search, profile/core selection, inspectable bounded packet, no worker. Gate: no model/network call during startup/lookup, no post-answer turn, no unrelated-project/personal leakage, source citation integrity, correction priority, failure-open behavior and readable missing-source states.
3. **Worker:** manual run first, idle opt-in later. Gate: mock provider verifies exact payload (no conversation/tools/credentials), invalid citations/output rejection, budget/admission races, abort/late-result safety, unavailable model, unknown billing, no fallback, no duplicate paid retry, usage ledger. Live model quality evaluation is separately opt-in.
4. **Legacy trial and usability:** dry-run and explicit source import, review inbox, startup-picker integration and independent loading. Gate: old backend unchanged before switch, no simultaneous reminder/notes, rollback documented, export preserves originals, unresolved references reported.
5. **Evaluate before expanding:** curated coding and continuity recall cases; measure relevance, missed useful items, context bytes, latency and actual maintenance cost. Inspect whether generated descriptions lose negation, temporal limits, uncertainty, corrections or reflective voice. No automatic extraction/embeddings/daemon until a measured gap justifies them.

Actual Pi integration checks must exercise reload/resume/fork/tree, compaction retries (including retained-tail sessions), repeated prompts, model changes, two concurrent runtimes, TUI/RPC/print/JSON, memory-off during requests, package exclusion and existing workpad/personality ordering. Fixture tests do not establish live API compatibility; an inspected example is not an executed test.

Quality fixtures should include: unrelated repo question retrieves no project crossover; an old stable preference survives recency ranking; “not anymore” supersedes an older fact; assistant speculation stays labelled; a reflective note yields an original passage rather than a generic personality rule; an open thread never becomes a task launch; malicious source instructions cannot invoke tools or promote themselves into core. Use synthetic or explicitly approved samples, not personal journals in the test suite.

## Remaining choices

The recommended defaults above make proposal work non-blocking. Before live rollout, confirm the store location, core/profile selection, source snapshot retention, worker model/endpoint and privacy scopes. Tune budgets with measurements. Semantic recall beyond FTS (local embeddings or optional reranking) is deferred, not ruled out; any added provider boundary needs separate controls.

Pi contracts consulted: installed `docs/extensions.md`, `docs/session-format.md`, `docs/compaction.md`, `docs/packages.md`, and `examples/extensions/summarize.ts`. Recheck installed types and actual lifecycle behavior when implementing. No runtime, model call, migration or test execution is claimed by this design.
