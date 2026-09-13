# Generalist pi extensions

Independent, opt-in personality and compact memory extensions for pi 0.85.1 (@earendil-works distribution).

## Install / use

```sh
pi install ~/workspace/pi-generalist-extensions
```

Run `/reload` in an existing pi session, or start a new one.

- `/meitan [on|off|status]`: toggle personality; no argument flips it.
- `/memory`: native memory status; `/memory configure`, `/memory on`, `/memory off`, `/memory context` and review controls.
- `/tasks [clear]`: view or clear the branch-local task checklist.
- `/questions [list|clear]`: answer, inspect, or discard asynchronously queued questions; `Ctrl+Shift+Q` opens the oldest batch.
- `pi --meitan`: enable personality initially. `--memory-config /absolute/config.json` selects native configuration but does not enable memory.

Both default off. Native memory requires an explicitly configured store and project/profile mapping, and a human activation decision. Memory grants are session/cwd/config-bound: reload/resume/tree restore them, but new/forked sessions start off. `/memory off` immediately blocks new captures and recall; other changes wait for idle. Personality retains its existing branch/CLI behavior. Enabled features appear in the footer.

## Startup questions

A fresh interactive `pi` (or `/new` in an unconfigured launch) asks, in order:

1. **Personality / memory:** plain coding, coding + native memory, Meitan only, or Meitan + native memory. Memory requires `/memory configure` first; unavailable configuration warns without blocking model selection.
2. **Model / thinking preset:** recently used combinations, keep the current combination, or choose another model and thinking level. The model browser supports typing to filter; thinking choices reflect the selected model's supported levels.

The eight most recently used model/thinking combinations appear first, newest first. Choosing one promotes it; combinations actually used after `/model` or thinking changes are also remembered. History lives in `~/.pi/agent/generalist-model-history.json` (under pi's agent directory when overridden), shared across projects. It stores only provider/model IDs and thinking levels—not credentials or conversation content. Writes are atomic and best-effort; simultaneous pi processes may race on recency. Unavailable, out-of-scope, and no-longer-supported combinations are hidden. Pi's configured default model/thinking settings are **not** changed, and previous choices are never applied silently to a new session.

No automatic questions for resumed/forked/saved sessions, `/reload`, print/JSON/RPC mode, or launches with explicit model/provider/thinking/scoped-model/preset/toggle flags (including Kouseki launches). Initial prompts/files and unknown launcher switches also suppress the picker conservatively. Ordinary name, extension/resource, offline, and terminal-display options are allowed. `pi --no-session-setup` explicitly skips startup questions.

Use **`/session-setup`** to open both steps manually in an interactive session, even when launch flags suppressed startup. Existing `/meitan`, `/memory`, and `/model` commands still work independently. Cancel the first question to keep everything unchanged; cancel model selection to keep the chosen personality/memory but leave model/thinking unchanged. No automatic re-prompt on reload. History errors warn without blocking session choices; delete a corrupt history file to reset recents.

The package loads `extensions/generalist.ts`, which initializes both independent features before the picker. `meitan.ts` and `memory.ts` also work as standalone extensions without startup questions; don't load them separately alongside the package.

## Agent switchboard

Switchboard automatically registers interactive Pi sessions after `/reload`, with
same-project roster observations and pending-mail hints at existing model requests.
When alone it adds no roster context; it never wakes an idle model. `/switchboard`
opens the roster/inbox, and the `switchboard` tool supports addressed correspondence
and interruptible `wait` for mail/user input. A small per-user Linux helper starts
on demand (Node 24+ and `flock`), with no systemd installation or inference.

**Opt out:** `PI_SWITCHBOARD=off` before launch (no registration/storage),
`/switchboard off` for this session, or `/switchboard project-off` for the project.
`/switchboard manual` keeps human observability but suppresses new automatic
context. Names and explicitly supplied summaries are public to local participants;
no transcripts or automatic trace summaries are collected. Workers can use scoped
participant capabilities, but a subagent launcher/general process wait is **not**
in this MVP. See [commands, privacy, limits and validation](docs/switchboard.md).

## Tasks and user questions

`update_plan` maintains an atomic, ordered checklist for meaningful multi-step work. Every update supplies the complete list with `pending`, `in_progress`, or `completed` status; at most one step may be in progress. State lives in session history, follows branches, and appears as a compact editor widget and footer count. `/tasks` opens the full list and `/tasks clear` removes it.

`ask_user` blocks on one to three questions when work cannot proceed without an answer. Questions can provide choices with tradeoff descriptions, and always permit free text. In TUI mode they use a compact right-side overlay with numbered choices, inline free-text editing, progress across a batch, and cancellation that leaves queued questions pending; RPC uses native select/input requests. `queue_questions` instead records a batch immediately so useful work can continue. Pending questions appear in a widget; `Ctrl+Shift+Q` answers the oldest batch without disturbing the main editor draft, while `/questions` can select among batches. Answers become a new user message—steering the active turn when work is still running, or starting a turn when idle. `/questions list` inspects the inbox and `/questions clear` discards it. Queued state is branch-aware and survives reload/resume. Blocking questions require TUI or RPC UI; queued questions can be created without UI and answered in a later interactive run.

Both extensions are original Pi-native implementations with no runtime dependency beyond Pi's bundled APIs. They are also usable as standalone files (`extensions/tasks.ts` and `extensions/questions.ts`), but should not be loaded separately alongside the package entrypoint.

## Context ownership

`~/.meitan/` owns the personality independently of Hermes. SOUL.md and COMPANION_CONTEXT.md are re-read on each enabled prompt (combined cap 50 KB). USER_NOTES.md, PROJECT_NOTES.md, and NOTES_CONVENTIONS.md are on-demand references, not auto-injected. Missing required files produce a visible error and an explicit unavailable-context instruction; no fallback to Hermes or stale cached context.

Set `PI_MEITAN_HOME` to another **absolute** directory if needed. This repo contains code, not personal context; it never creates or edits your context files. The initial local migration copied Hermes files without changing the originals; future changes are not synchronized. Journal stays at `~/workspace/meitan_journal`.

## Native memory

The `memory` tool provides scoped indexed recall, accepted-original reads, authored
notes/revisions, exact host-bound source excerpts and open-thread cues. Automatic
recall is bounded, request-frozen and inspectable with `/memory context`. Candidates
and unassigned records are never automatically recalled; personal scope requires
an explicitly selected continuity profile. No worker, provider call, compression,
post-answer reminder or shutdown save is added by this extension.

See [first-use setup, commands and privacy/lifecycle contract](docs/memory-runtime.md),
[index semantics and budgets](docs/memory-index.md), and [portable store](docs/memory-store.md).
Workpad remains in-session working context; durable memory is out-of-session.
**Off is not amnesia or a filesystem sandbox:** prior outputs, packet audits,
exports and backups remain. Ordinary shell/read tools retain filesystem access.

The OptMem runtime is removed. Remove obsolete standalone `optmem.ts` resources
and `--optmem` launcher flags, then reload Pi. Existing archives remain untouched.
The [offline importer](docs/memory-migration.md) remains for a separately approved
migration, with digest-gated staging, unassigned review, classification/acceptance,
and confirmed purge. No live archive is imported or native backend enabled automatically.

## Reflective continuity

`/continuity` provides a separate, explicit shelf for reflective Markdown originals
and a bounded return-context attachment. It does not change `/meitan` or `/memory`
activation and never installs or scans personal journals automatically.

Register selected files with `/continuity register ID /absolute/file.md`, then
`/continuity reindex` for local lexical search. `/continuity on` approves read-only
model access for this session/cwd. `/continuity attach ID:START-END [ID:START-END]`
previews and approves one anchor plus an optional second original passage (8 KiB
complete packet). `/continuity context` shows the actual last projection audit;
`/continuity off` revokes new tool access immediately and marks earlier selections
historical. Snapshots stay at fixed message boundaries for cache-prefix reuse;
unchanged passages are not moved or repeated on each user turn. New/forked sessions
start off. Originals remain exact writing, not summary-derived
personality instructions; missing/changed sources are explicit. No automatic
selection, worker calls, journal writing or reminders. See [commands, privacy,
storage and lifecycle limits](docs/continuity.md).

## Cross-harness history search

The package also exposes `history_search` and `history_read`, independently of the
personality/memory toggles. Local SQLite FTS5 searches Pi, OMP, Codex and Hermes
prose with citations and bounded, branch-aware drill-down. No embeddings, model
calls, startup indexing, auto-injection, session switching or source mutations.
`/history-index` refreshes; `/history-index status` shows counts and disk usage.
Additional roots (such as Kouseki's separate Pi-agent histories) are configured
explicitly. Requires Node 24+ with `node:sqlite`/FTS5; no new runtime dependency.
See [configuration, privacy, limits and validation](docs/history-search.md).

## Task workpad (MVP)

`/workpad new ID` creates and attaches a durable Markdown task notebook;
`/workpad` opens its dismissible viewer, `/workpad edit` edits it, `/workpad list`
selects another, and `/workpad off` detaches. The `workpad` tool offers explicit
creation/attachment, reads and revision-checked updates. Revision-labelled snapshots
are journalled and replayed at fixed conversation boundaries for append-only cache
reuse. `/workpad size 2|4|8` selects the KiB cap (default 4); `/workpad refresh 10`
adds optional reminders after estimated context growth (off by default).
New/forked sessions start detached. Independent of personality and native memory.
See [storage, context/privacy, limitations and phase-two scope](docs/workpad.md).

## Evidence shelf

`/evidence` opens an ephemeral source-evidence picker; `/evidence capture` records
an immutable excerpt, `/evidence check ID` checks whole-file freshness, and
`/evidence compare ID` shows captured/current line positions. The `evidence` tool
provides the same operations. Source observations and inspected test contracts
are distinct; neither is a test pass or truth verdict. Records stay project-scoped
outside Git, with no background work or automatic context injection.
See [bounds, privacy, semantics and validation](docs/evidence.md).

## Development

```sh
bun install
bun test
bun run typecheck
```

Tests use synthetic temporary context/history, mocked hooks and real Pi session branches. A separate Node/Pi loader/agent-loop fixture uses a scripted stream with network disabled; tests do not read/write personal memory or call a live model. On the original machine, installation of the exact already-installed pi 0.85.1 required `bun install --minimum-release-age=0` because it was newer than the local release-age policy.

Uninstall: `pi remove ~/workspace/pi-generalist-extensions`, then `/reload`. Personal context and memory are retained.
