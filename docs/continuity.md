# Reflective continuity

Implementation contract for two approved slices: selected reflective originals and
an explicit return context. Independent of `/meitan` and `/memory`; neither toggle
activates this feature. No personal sources are installed with this package.

## Interface

- `/continuity register ID /absolute/file.md`: preview and confirm retention of one
  UTF-8 Markdown original in the local shelf. Paths may contain spaces. No directory
  scans, globs or link following. Registration does not activate model access.
- `/continuity refresh ID`: explicitly preview and confirm a changed source snapshot.
  Existing attachments do not silently follow the change; reattach them.
- `/continuity remove ID`: confirmed removal of the owned source record and index.
  External originals are never edited or deleted. Old session excerpts remain.
- `/continuity reindex`: rebuild a disposable local lexical index from registered
  snapshots. Registration/refresh/removal invalidate that index, not silently rebuild it.
- `/continuity on`: human approval for this session/cwd to expose registered originals
  through the read-only tool. Discloses the foreground model destination and scope.
- `/continuity attach ID:START-END [ID:START-END]`: preview/confirm one anchor and an
  optional second reflection. Enables access for this session/cwd. The complete
  labelled packet must fit 8 KiB; choose smaller explicit spans rather than truncate.
- `/continuity off`: immediately disables new tool access and appends an inactive
  selection notice. Already-sent snapshots remain historical at their original
  boundaries until compaction; off does not erase context, audits or filesystem copies.
- `/continuity`, `/continuity status`: configuration/attachment status.
- `/continuity context`: inspect the exact most recent context projection audit, not
  a fresh reconstruction. The audit may predate off, a model change or a source edit.

The `continuity` tool supports `list`, `search(query)`, `read(id,start?,end?)`,
`check(id)` and `context`. Except for context inspection, it requires human session
activation. It cannot register, refresh, remove, activate or attach sources. No
subagent use. Normal read/shell access is not a filesystem sandbox.

## Originals and index

Portable versioned JSON source records live under the Pi agent directory's
`continuity/sources/`. Each contains the complete unchanged Markdown snapshot,
SHA-256, canonical external locator, registration identity and capture timestamp.
Capture time is not the original writing date; authorship is not inferred. Dates,
signatures, qualifications and links inside the original remain intact. A refreshed
record replaces the owned snapshot after confirmation; old session excerpts remain,
but the shelf is not a revision archive. Keep the journal's own Git history.

Limits: 100 records, 128 KiB per original, 1 MiB per serialized record, 32 MiB index,
16 KiB tool read text, 160 lines per read, 10 search results. Invalid UTF-8, empty
files, special files and symlink final components are rejected. Canonical parent
paths are resolved at registration. This is not protection against a hostile local
account changing ancestors concurrently. Writes use a fail-fast exclusive lock and
atomic publication; a crash can leave a lock needing manual inspection, never
automatic stale-lock stealing.

The disposable JSON index contains local token postings and source-generation
metadata, not summaries or replacement prose. Reindexing is explicit; stale or
missing indexes fail clearly. Search ANDs bounded terms, excludes common stopwords,
and returns source IDs and matching line locators, not invented descriptions.
Search does not scan external source files or invoke a model. `read` returns the
retained original, explicitly labelled with the current external check state;
`check` compares current bytes. Changed/missing/unsafe sources cannot be attached.

Registration gives the human's selected shelf a global local identity, not a native
memory scope. `/continuity on` explicitly grants access to this shelf from the current
session/cwd. There is no implicit project-to-personal crossover or inheritance of
native memory grants. The shelf is intended for selected reflective files, not bulk
history. Nothing is automatically promoted into native memory.

## Context and lifecycle

Attachment approval retains exact spans plus source identities in branch state.
Snapshots are journalled as scoped custom entries and projected at **fixed message
boundaries**. The first attachment is appended after the existing context; unchanged
snapshots stay there across subsequent user requests, tool follow-ups, retries and
reload. Source/status changes append a new superseding snapshot without rewriting
previous context. Tool definitions and the system prompt remain stable. The shared
workpad projection helper uses a separate continuity namespace; the features do not
share state or attachment ownership.

Selection is frozen over tool turns; no per-tool search or source scan. A new request
checks the selected registration/hash and external bytes. An unavailable selection
appends an explicit unavailable notice, never a stale substitute as the current
selection. Previously supplied excerpts remain historical at their old boundaries.
Changes during an active request are detected on the next request; explicit off
revokes tool access immediately and appends an inactive notice at the next model call.
Pending approvals cannot re-enable access after off or a lifecycle change.

A projection audit records the exact latest selected snapshot text and omission
state; inspect it with `/continuity context`. It is not a full replay of all historical
snapshots. New/forked sessions never newly project a parent's private snapshots.
Reload/resume/tree restore only matching session/canonical-cwd/root branch choices.
Compaction starts a new projection epoch containing only the current selection or
inactive/unavailable notice; internal retries retain frozen selection. External
context trimming invalidates incompatible anchors rather than resurrecting later
snapshots at guessed positions.

A conservative model-context estimate can replace a **new** over-budget snapshot
with a small omission notice, never truncate its original prose. Already-sent history
is not silently rewritten to fit a smaller model: Pi compaction remains responsible
for that. Each selected packet is bounded to 8 KiB, not the accumulated history of
explicit attachment changes. Byte bounds are not token guarantees. Prefix identity
is tested at the serialized message and scripted SDK request boundary, not a promise
that a provider will retain or bill a particular cache entry.

No timers, worker/provider calls, implicit diary writing, shutdown saves, idle
wakes, reminders or actions inferred from old threads. Reflective prose is untrusted
historical material, not higher-priority guidance or proof of uninterrupted experience.

## Validation

Use synthetic originals only in tests. Exercise storage integrity and races,
index invalidation, exact line spans/Unicode bounds and indentation, pending-approval
revocation, independent activation, fork/cwd isolation, tree restore, compaction,
repeated context calls, source change, removal, off and exact audit inspection.
Cache regressions compare unchanged provider-bound prefixes across user turns,
tool follow-ups, retries, reload, source changes and off; composition with workpad
is tested separately. The Node/Pi loader and agent-loop fixture uses a scripted
stream with network disabled. These checks establish integration mechanics, not
live provider cache billing, model quality or human acceptance.

Run `bun test tests/continuity.test.ts tests/continuity-sdk.test.ts tests/workpad.test.ts`
and `bun run typecheck`. No real journal has been registered or activated by these tests.
