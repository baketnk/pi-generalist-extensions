# Workpad

A task notebook for current understanding, evidence pointers, tentative designs
and unresolved questions. Not a todo list, project backlog, long-term memory,
source of authority, or hidden reasoning transcript. No scheduler, background
summarizer, model calls, watchers or automatic attachment.

## Commands

After `/reload`:

- `/workpad new ID`: edit a new page, save it and attach it.
- `/workpad`: dismissible read-only snapshot of the attached page.
- `/workpad edit`: edit through Pi's normal editor dialog.
- `/workpad list`: select an existing project notebook to attach.
- `/workpad attach ID`: explicitly attach a known notebook.
- `/workpad off`: detach, retaining files and historical snapshots.
- `/workpad size 2`, `size 4`, `size 8`: set the active-page cap in **KiB of UTF-8 bytes**, not tokens. Default **4 KiB**.
- `/workpad refresh off`: publish only on state changes/compaction (default).
- `/workpad refresh 10`: also repeat unchanged notes after estimated new conversation tokens reach 10% of the model's context window. Accepts integer percentages 1–100.

Size and refresh settings are session/canonical-cwd scoped, persisted in branch
entries and restored on reload. New/forked sessions use defaults. Reducing the
cap below an attached page's size fails without truncation or changing settings.
Increasing the cap can recover an old oversized attachment. Missing model-window
information disables periodic reminders, not publication of edits.

The viewer uses configured `tui.select.*` keys for scrolling/pages/cancel.
Closing it does not detach; reopen to refresh its snapshot. Commands wait for
the agent to settle. The custom viewer requires TUI mode; RPC can use ordinary
editor/selector dialogs. Non-UI callers use the tool.

## Model tool

`workpad` is independent of personality and OptMem. Examples:

```json
{"action":"create","id":"surface-design","content":"# Surface design\n\nStill uncertain."}
{"action":"attach","id":"surface-design"}
{"action":"read"}
{"action":"update","expectedRevision":1,"content":"# Surface design\n\nRevised understanding; see source X."}
{"action":"read","revision":1}
{"action":"list"}
{"action":"detach"}
```

Create does NOT attach. Reads may specify another `id`; writes only update the
attached notebook and require its exact current revision. Competing writers get
a conflict, never silent last-writer-wins replacement. Read and reconcile again.
`list` includes the current `settings`. Results include revision and filesystem
path. Supporting material can be linked and read with normal file tools.

Writes enforce the selected 2/4/8 KiB cap and reject empty pages. Historical reads
remain available up to the absolute 8 KiB storage limit, even with a smaller cap.
An existing over-budget attachment produces an explicit unavailable marker until
the page is shortened or the cap increased; its content is never silently trimmed.
A conflicted/oversized user edit opens a recovery editor containing the unsaved
draft. Closing that dialog discards it; durable draft recovery remains deferred.

## Append-only model context

The model sees stable, revision-labelled snapshots:

```text
request 1: [A B W1]             -> C
request 2: [A B W1 C D]         -> E       (page unchanged)
request 3: [A B W1 C D E F W2]   -> G       (page edited)
```

Earlier snapshots never move or change between compactions. New ones are
published at the next model request after attachment, edits, notebook switches,
or changes to availability. Multiple edits before that request coalesce into the
latest revision. No ordinary request republishes an unchanged page by default.
Optional reminders retain the revision and explicitly say they are reminders.
Each current snapshot supersedes earlier snapshots as working notes, not as
proof or instructions. On detach, a short inactive marker supersedes the active
state; prior history is retained. Forked sessions do not inherit attachment and
label any inherited snapshots inactive.

### Persistence and positioning

The `context` hook journals each publication with `pi.appendEntry` as a
`workpad-snapshot-v2` custom entry: immutable snapshot text, state key, fixed
publication timestamp, compaction epoch, original-message position and a hash
of the preceding original messages. It reconstructs those snapshots at the
**same boundaries** on subsequent requests. This is a durable model-context
projection, not `sendMessage` or repeated writes of ordinary conversation
messages. It avoids message-queue timing moving a publication from before an
assistant response to after it. Initial publication follows all current messages,
including complete tool-result batches. No extra agent turn is triggered.

The selected branch owns the journal. Reload/resume replays it without duplicate
publication. Only workpad projections are stripped if a context pipeline feeds
one back; unrelated custom messages are preserved. If another component rewrites
the preceding original messages, unmatched anchors are not guessed or relocated:
a fresh current snapshot is appended. Such rewrites can themselves break caching.

Compaction starts a new epoch. Old journal entries remain in the session file but
are not replayed in the compacted model context. The latest attached page (or an
inactive/unavailable marker) is restored on the first request after compaction.
Pi's ordinary compactor sees ordinary conversation/tool messages, **not this
custom-entry projection**; it is not responsible for summarizing notebook history.
The file-backed current page supplies continuity instead. No extra summarizer runs.

Pi converts snapshots to **user-role working data**, not system policy. Current
user instructions and canonical project contracts take precedence. JSON framing
separates page content from the wrapper, but is not a prompt-injection security
guarantee. Framing/JSON escaping add overhead beyond the page-byte cap. Supporting
notes are not automatically included.

### Cache costs and limits

This replaces both MVP prepending and the moving request-tail snapshot. In the
original live `openai-codex/gpt-6-astra` session, unchanged prepended pages saw
about 99.8% cached input; two edits dropped to 2.31% and 2.24% (4,736 cached versus
200,719 and 206,934 uncached tokens). A moving tail protected older conversation
but unnecessarily broke reuse at the former snapshot position on every new turn.
The append-only projection instead preserves the entire prior request prefix
when ordinary messages are appended, whether or not the page changes.

The cap bounds **each page**, not cumulative historical snapshots. Edits/reminders
consume new input and grow the context until normal compaction. Refresh thresholds
use Pi's message-token estimator on original messages since the last snapshot;
they exclude snapshot text and are approximate, not provider token accounting.
There is no timer or model request solely to refresh notes.

Compaction, cache expiry, provider thresholds, changed system/tools, migration
from older placement, and other context-rewriting extensions can still cause
misses. Tests establish stable converted-message prefixes, not provider cache
hits. Post-reload live verification remains pending: explicitly attach, warm an
unchanged request, edit, and compare the following requests' session JSONL usage.
Pi's cached-input share is `cacheRead / (input + cacheRead + cacheWrite)`; `input`
is uncached and output is excluded. Record model, request IDs and any reload or
compaction boundaries. Never reattach a user-disabled page merely to test it.

**Off is not amnesia**: published snapshot text is now also retained in session
journal entries, in addition to page files, tool reads and discussions. Attaching
sends it to the active provider. Do not put secrets in a notebook.

## Markdown storage and attachment

Storage: `getAgentDir()/workpads/<sha256(canonical cwd)>/<id>/`, normally under
`~/.pi/agent/workpads/`. Project means exact realpath cwd, not inferred Git root.
Symlink aliases share scope; different subdirectories do not. IDs are 1–64
lowercase letters, digits or hyphens. Listings are capped at 100 notebooks; known
IDs remain directly addressable.

Revisions are immutable owner-only UTF-8 Markdown files (`00000001.md`, etc.).
Restore old content by reading a revision and publishing against the current
revision; never edit revision files in place. There is no pruning/deletion tool.
A flushed temporary file is atomically hard-linked to the next revision name for
cross-process compare-and-swap; directory flushing is best effort. Hard links are
required, and this is not a comprehensive power-loss guarantee. Crashes may leave
ignored `.pending-*` files. Store/notebook/revision symlinks are rejected, but
ordinary file tools can still alter files: this is not a same-account security
boundary.

Attachment uses `workpad-attachment-v1` custom entries keyed by canonical cwd and
session ID. It survives reload/resume/compaction and follows branch choices;
notebook content is shared latest revision, not historical branch content.
New/forked/cloned sessions start detached. Workers must explicitly attach; this
is a behavioral rule, not a worker ACL.

## Validation and deferred polish

`bun test tests/workpad.test.ts` covers immutable writes, UTF-8 limits, independent
writers, explicit attachment, append-only converted prefixes, duplicate-free
reload/retries, original tool-pair ordering, branch/fork/compaction behavior,
inactive/unavailable markers, size settings, periodic reminders, real
SessionManager journal replay, draft recovery and viewer rendering.
`bun test` and `bun run typecheck` validate the full package. No personal notebook
store or provider is used by tests. Live post-compaction inference and actual
post-fix provider cache rates remain unverified until user reload/acceptance.

Named supporting notes, durable draft recovery, richer rendering/history/diff UI
and targeted text edits remain separate polish. The earlier targeted-edit WIP is
parked in the Git stash named `WIP workpad targeted edits paused for cache fix`;
it is not part of this delivery. No deferred item is authorization to resume work.
