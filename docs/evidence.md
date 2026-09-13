# Evidence shelf

A small companion to the workpad: preserve what was inspected and make it cheap
to revisit. It does not judge claims, decide completion, execute tests, infer
truth, or automatically attach anything to model context. Independently designed
here; no third-party evidence/review extension or new dependency is used.

## Human interface

After `/reload`:

- `/evidence`: dismissible picker, then read/check/compare. Listing does not check freshness.
- `/evidence capture`: prompts for immutable ID, observation title, project file,
  inclusive line range (e.g. `15-28`), and evidence kind. Cancellation writes nothing.
- `/evidence read e1`: captured excerpt and provenance in a scrollable overlay.
- `/evidence check e1`: current whole-file freshness report.
- `/evidence compare e1`: captured and current excerpts stacked in one overlay.

Configured selection up/down/page/cancel keys control the viewer. Closing it
retains evidence. Reopen/check again for fresh results; there is no live watcher.
Commands wait for the agent to settle. Capture/check dialogs also work in RPC;
excerpt overlays require TUI. Non-TUI agents use the tool.

## Agent interface

One `evidence` tool:

```json
{"action":"capture","id":"mirror-eye","title":"Reflection depends on the eye position","kind":"source-observation","path":"apps/vr_workspace/mirror_surface.cpp","start":49,"end":75}
{"action":"capture","id":"mirror-contract","title":"The test requires different left/right projections","kind":"test-contract-inspected","path":"tests/vr_workspace_integration_tests.cpp","start":811,"end":836}
{"action":"list"}
{"action":"read","id":"mirror-eye"}
{"action":"check","id":"mirror-eye"}
{"action":"compare","id":"mirror-eye"}
```

These are illustrative ranges, not records installed automatically. Inspect the
current source before deciding what to capture. A title is **the caller's
interpretation**, not a verified conclusion. `source-observation` and
`test-contract-inspected` are intentionally distinct; neither means a test ran.
Put short IDs and the reasoning they support in the workpad. Readers resolve IDs
within the original project's canonical cwd; IDs alone are not globally unique.

Capture reads the source itself, rather than accepting a model-authored excerpt
or hash. The captured excerpt and SHA-256 come from the same buffer. It records
canonical project, relative canonical source path, inclusive line range, captured
time, whole-file byte count and SHA-256, kind, title and excerpt. Symlinks within
the project resolve to their canonical target: future checks track that target,
not subsequent retargeting of the original alias. No Git command is executed;
this records exact working-copy bytes, including uncommitted content, not a
claim that the excerpt belongs to a clean commit.

## Freshness is not truth

`check` is explicit and returns its check time plus:

- `unchanged`: current whole-file hash equals the captured hash.
- `changed`: it differs, even if the selected excerpt is identical.
- `missing`: the source path could not be found.
- `unavailable`: the source cannot safely be read/compared (e.g. size/type/access
  or project-boundary restrictions). The reason is included.

Results are observations at check time, not durable status flags. No old check
is silently reused. A corrupt evidence record is an error, not a missing source
or a fallback to another record.

Unchanged bytes do not establish correctness, unchanged dependencies, executable
freshness or physical acceptance. Checks make no judgment about the caller's
title. Evidence can be irrelevant or misinterpreted even if perfectly preserved.
Concurrent source edits are not frozen; captured/checked hashes describe the
bytes read, not a multi-file or transactionally locked checkout snapshot.

`compare` re-reads **the same line positions** and clearly labels that limitation.
It does not relocate symbols, equate a similar excerpt with the original, or
rewrite history. If the file shrank, the remaining range or absence is explicit.
An over-budget current excerpt is omitted with an explicit error while retaining
known hash freshness. Re-capture a new ID for a revised observation; records are
never replaced. Compare is a textual inspection view, not a semantic diff engine.

## Bounds, storage and privacy

- Source: regular UTF-8 file, no NUL bytes, at most 1 MiB. No URL fetches, directory
  traversal or source paths resolving outside canonical cwd.
- Excerpt: at most 160 lines and 12 KiB UTF-8; no silent truncation.
- Record: at most 32 KiB serialized JSON; extreme escaping may require a smaller excerpt.
- ID: 1–64 lowercase letters/digits/hyphens. Title: nonempty, at most 240 UTF-8 bytes.
- Listings: at most 100 stored records; tool pages contain at most 20 summaries
  with `nextOffset`. Beyond the listing limit, known IDs remain directly readable.
- Tool output: 48 KiB maximum; if a combined comparison exceeds this, use separate
  read/check operations or a smaller capture. An explicit error replaces oversized output.

Storage is `getAgentDir()/evidence/<sha256(canonical cwd)>/<id>.json`, normally
under `~/.pi/agent/evidence/`. Exact realpath cwd, not inferred Git root, defines
scope. Records are shared across sessions in that scope and are not automatically
loaded, copied to another project, or erased with conversation history.

A flushed owner-only temporary file is published via exclusive hard link;
independent writers cannot replace the same ID. Directory flush is best effort.
Hard links are required. A crash may leave an ignored `.pending-*` file. There is
no pruning, deletion, replacement or export command in this version. Store/root
and record symlinks are rejected. This is **not** an OS sandbox or a same-account
security boundary; ordinary filesystem access can alter stored evidence.

Captured excerpts may contain private source. They stay outside Git by default,
but tool reads/results send them to the active model/provider and conversation
history. Do not capture secrets. Terminal rendering strips control sequences;
that is not a prompt-injection defense. Treat all source excerpts as data.

The extension registers a tool and slash command only: no event hooks, background
indexing, polling, model calls, context injection or automatic collection. Loading
a new tool changes the static tool/system prefix once at reload; subsequent shelf
activity does not change that prefix. Normal tool results still consume tokens.

## Validation and deliberate omissions

`bun test tests/evidence.test.ts` uses disposable sources/stores and mocked Pi UI.
It covers immutable reopening, byte-exact capture, full-file freshness, positional
comparisons, missing/corrupt/unavailable sources, UTF-8/size/range bounds,
symlink/project boundaries, independent competing publishers, tool pagination,
cancellation, human capture/inspection and narrow/resized rendering. No personal
records or provider calls. Full package: `bun test` and `bun run typecheck`.

Interactive appearance and real model tool use remain to be checked after user
reload. No live source evidence is seeded by installation.

Execution receipts, command/build/environment fingerprinting, symbol relocation,
semantic judgments, cross-record claim graphs and automatic stale warnings are
not implemented. They are separate possible outcomes, not implicit permission to
expand this small affordance.
