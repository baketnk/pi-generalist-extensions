# Workpad — phase-one MVP

A task notebook for current understanding, evidence pointers, tentative designs
and unresolved questions. Not a todo list, project backlog, long-term memory,
source of authority, or hidden reasoning transcript. No scheduler, background
summarizer, model calls, watchers or automatic attachment.

## Start and inspect

After `/reload`:

- `/workpad new surface-design`: edit a new page, save it and attach it.
- `/workpad`: dismissible read-only snapshot of the attached page.
- `/workpad edit`: edit through Pi's normal editor dialog.
- `/workpad list`: select an existing project notebook to attach.
- `/workpad attach surface-design`: explicitly attach a known notebook.
- `/workpad off`: detach, retaining files and revision history.

The viewer uses configured `tui.select.*` keys for scrolling/pages/cancel.
Closing it does not detach; reopen to refresh its snapshot. The footer indicates
which notebook is attached. Editing/attachment commands wait for the agent to
settle. The custom viewer requires TUI mode; RPC can use the ordinary editor and
selector dialogs. Non-UI callers use the tool, not slash commands.

## Model tool

`workpad` is independent of personality and OptMem. Examples:

```json
{"action":"create","id":"surface-design","content":"# Surface design\n\nStill uncertain about mirror sampling."}
{"action":"attach","id":"surface-design"}
{"action":"read"}
{"action":"update","expectedRevision":1,"content":"# Surface design\n\nRevised understanding; see source X."}
{"action":"read","revision":1}
{"action":"list"}
{"action":"detach"}
```

Create does NOT attach. Reads may specify a different `id`; writes only update
the attached notebook. Full-page updates require the exact current revision.
Competing writers get a conflict, never a silent last-writer-wins overwrite.
Read again and reconcile intentionally. The tool returns the revision and its
ordinary filesystem path; supporting material can be linked and read with the
normal file tools. Named supporting-note operations are deferred to phase two.

An active page must be nonempty and at most **8192 UTF-8 bytes**, not characters
or tokens. Oversized writes fail without changing the current revision; the
extension never trims or summarizes them. If a user edit conflicts or exceeds
the budget, a recovery editor opens with the unsaved draft for copying. Closing
that dialog discards the draft; durable draft recovery is phase-two work.

## Persistence and context

Storage is under `getAgentDir()/workpads/<sha256(canonical cwd)>/<id>/` (normally
`~/.pi/agent/workpads/`). Project means the exact realpath of the session cwd,
not an inferred Git root. Symlink aliases of the same cwd share notebooks;
different subdirectories have different scopes. IDs are 1–64 lowercase letters,
digits or hyphens. Listings are capped at 100 notebooks per project; known IDs
remain directly addressable beyond that limit.

Each revision is an immutable, owner-only, UTF-8 Markdown file such as
`00000001.md`. To restore old content, read that revision and publish its content
against the latest revision. Do not edit revision files in place. There is no
pruning/deletion command in the MVP.

A temporary file is flushed and atomically hard-linked to the next revision
name. Exclusive publication provides cross-process compare-and-swap without
stale-lock handling. The directory is flushed best-effort. This requires a
filesystem supporting hard links and is not a comprehensive power-loss guarantee.
A crash before publication may leave an ignored `.pending-*` file. Published
pages are never partial. Root/project/notebook symlinks and revision symlinks are
rejected, but this is NOT a security boundary against another process with the
same account: ordinary file tools can still alter the store.

Attachment is a small Pi custom entry, keyed by canonical project and session
ID. It survives reload/resume/compaction and follows active-branch attachment
choices. Forks, clones and new sessions have different IDs and start detached,
even when they inherit the parent's entries. Attachment choices branch; notebook
content does not: an attached branch always sees the latest shared revision.
Workers must explicitly attach; an instruction also tells subagents not to attach
or edit a parent's workpad without permission. This is not a worker ACL.

Before every ordinary model request, the `context` hook appends one hidden
custom message containing the latest page and its revision **after the entire
conversation, including tool results**. Pi converts it to
**user-role context**, not system policy. It is labelled as working data, not a
request, verification or permission. JSON framing distinguishes the page from
the wrapper but is not a prompt-injection security guarantee. The wrapper and
JSON escaping add overhead beyond the raw 8 KiB page limit. Supporting notes
are not included. Missing/corrupt pages produce an explicit unavailable marker,
not a stale cache or guessed replacement.

This is request-local: there is no `sendMessage`, extra model turn or page copy
appended to session history. Identical revisions have stable injected content.
Page edits, attachment changes and unavailable markers only change the trailing
snapshot, not the preceding conversation. Any synthetic copy fed back through
the hook is removed before the latest snapshot is appended.

### Cache behavior

The original MVP prepended the page. In a live `openai-codex/gpt-6-astra`
session, unchanged pages saw approximately 99.8% cached input, but the first
requests after two page edits fell to 2.31% and 2.24%: only 4,736 cached tokens
versus 200,719 and 206,934 uncached tokens. Subsequent unchanged requests
recovered. This motivated moving the snapshot to the request tail.

Tail placement preserves the conversation prefix when the notebook changes;
it does **not** promise zero cache cost. As conversation messages accumulate,
they replace the previous trailing snapshot's position, so that snapshot and
the new suffix may need processing again. The page remains bounded at 8 KiB
plus framing. Cache expiry, provider thresholds, other extensions, changed
system/tool definitions and compaction can independently affect reuse. Reloading
from the old placement can also cause a one-time miss.

Regression tests verify the stable prefix after Pi's message conversion, not
provider cache hits. To verify live after `/reload`, explicitly attach, warm
with an unchanged-page request, edit the page, then compare the next request's
`usage.cacheRead` and `usage.input` in session JSONL. Pi's input is uncached;
the cached-input share is `cacheRead / (input + cacheRead + cacheWrite)`.
Exclude output tokens. Record model, request IDs and any reload/compaction
boundaries. Post-fix live cache measurements are still pending; never reattach
a user-disabled page just to run that check.

**Off is not amnesia**: earlier tool reads, summaries and discussion may still
contain old page text. Do not put secrets in a notebook; attaching sends its
content to the active model/provider, including normal automatic follow-ups.

## Two-phase delivery

Phase one provides create/read/update/list/attach/detach, immutable history,
revision conflicts, basic viewer/editor, explicit session-scoped attachment and
bounded context injection. Stop here for the user's reload; do not continue
phase two merely because a notebook lists possible work.

After the user reloads and hands it back, use the attached notebook itself to
record findings and choose a small phase-two slice. Candidates, not commitments:

- Named supporting notes with read-on-demand tools and safe internal links.
- Markdown rendering, revision comparison/history picker and context-budget UI.
- Durable recovery of conflicted/oversized user drafts.
- Targeted revision-checked text edits rather than full-page replacement.
- Revisit context placement/cache cost and explicit sharing/project scoping from
  actual experience; no automatic summarization or stale-evidence claims.

## Validation

`bun test tests/workpad.test.ts` exercises immutable revisions, UTF-8 limits,
invalid paths/symlinks, two independent writer processes, lazy startup,
explicit attachment, cancellation, current request-local context conversion,
stable conversation prefixes across page edits and growing user/tool turns,
snapshot deduplication, unavailable/detached states,
compaction/reload-shaped branch restoration, fork/project isolation, editing
conflict recovery and narrow/resized terminal rendering. Fixtures use temporary
storage and a mocked Pi API; no providers or personal notebook stores.

Run `bun test` and `bun run typecheck` for the full package. A real offline RPC
loader smoke can establish command/tool registration, not visual TUI behavior
or an actual post-compaction model turn. Those remain phase-two interactive
acceptance after reload. No claim of working-note quality follows from unit tests.
