# Generalist pi extensions

Independent, opt-in personality and compact memory extensions for pi 0.85.1 (@earendil-works distribution).

## Install / use

```sh
pi install ~/workspace/pi-generalist-extensions
```

Run `/reload` in an existing pi session, or start a new one.

- `/meitan [on|off|status]`: toggle personality; no argument flips it.
- `/optmem [on|off|status]`: independently toggle compact memory.
- `/tasks [clear]`: view or clear the branch-local task checklist.
- `/questions [list|clear]`: answer, inspect, or discard asynchronously queued questions; `Ctrl+Shift+Q` opens the oldest batch.
- `pi --meitan --optmem`: enable both initially, including print mode.

Both default off until selected. Decisions are saved in the current session branch and restored on reload/resume/fork/tree navigation. Saved decisions take precedence over CLI flags. Slash-command changes wait for idle and apply to the next prompt. Enabled toggles appear in the footer.

## Startup questions

A fresh interactive `pi` (or `/new` in an unconfigured launch) asks, in order:

1. **Personality / memory:** plain coding, coding + OptMem, Meitan only, or Meitan + OptMem.
2. **Model / thinking preset:** recently used combinations, keep the current combination, or choose another model and thinking level. The model browser supports typing to filter; thinking choices reflect the selected model's supported levels.

The eight most recently used model/thinking combinations appear first, newest first. Choosing one promotes it; combinations actually used after `/model` or thinking changes are also remembered. History lives in `~/.pi/agent/generalist-model-history.json` (under pi's agent directory when overridden), shared across projects. It stores only provider/model IDs and thinking levels—not credentials or conversation content. Writes are atomic and best-effort; simultaneous pi processes may race on recency. Unavailable, out-of-scope, and no-longer-supported combinations are hidden. Pi's configured default model/thinking settings are **not** changed, and previous choices are never applied silently to a new session.

No automatic questions for resumed/forked/saved sessions, `/reload`, print/JSON/RPC mode, or launches with explicit model/provider/thinking/scoped-model/preset/toggle flags (including Kouseki launches). Initial prompts/files and unknown launcher switches also suppress the picker conservatively. Ordinary name, extension/resource, offline, and terminal-display options are allowed. `pi --no-session-setup` explicitly skips startup questions.

Use **`/session-setup`** to open both steps manually in an interactive session, even when launch flags suppressed startup. Existing `/meitan`, `/optmem`, and `/model` commands still work independently. Cancel the first question to keep everything unchanged; cancel model selection to keep the chosen personality/memory but leave model/thinking unchanged. No automatic re-prompt on reload. History errors warn without blocking session choices; delete a corrupt history file to reset recents.

The package now loads `extensions/generalist.ts`, which initializes both independent toggles before the picker. The original `meitan.ts` and `optmem.ts` remain usable as standalone extensions without startup questions; don't load them separately alongside the package.

## Tasks and user questions

`update_plan` maintains an atomic, ordered checklist for meaningful multi-step work. Every update supplies the complete list with `pending`, `in_progress`, or `completed` status; at most one step may be in progress. State lives in session history, follows branches, and appears as a compact editor widget and footer count. `/tasks` opens the full list and `/tasks clear` removes it.

`ask_user` blocks on one to three questions when work cannot proceed without an answer. Questions can provide choices with tradeoff descriptions, and always permit free text. In TUI mode they use a compact right-side overlay with numbered choices, inline free-text editing, progress across a batch, and cancellation that leaves queued questions pending; RPC uses native select/input requests. `queue_questions` instead records a batch immediately so useful work can continue. Pending questions appear in a widget; `Ctrl+Shift+Q` answers the oldest batch without disturbing the main editor draft, while `/questions` can select among batches. Answers become a new user message—steering the active turn when work is still running, or starting a turn when idle. `/questions list` inspects the inbox and `/questions clear` discards it. Queued state is branch-aware and survives reload/resume. Blocking questions require TUI or RPC UI; queued questions can be created without UI and answered in a later interactive run.

Both extensions are original Pi-native implementations with no runtime dependency beyond Pi's bundled APIs. They are also usable as standalone files (`extensions/tasks.ts` and `extensions/questions.ts`), but should not be loaded separately alongside the package entrypoint.

## Context ownership

`~/.meitan/` owns the personality independently of Hermes. SOUL.md and COMPANION_CONTEXT.md are re-read on each enabled prompt (combined cap 50 KB). USER_NOTES.md, PROJECT_NOTES.md, and NOTES_CONVENTIONS.md are on-demand references, not auto-injected. Missing required files produce a visible error and an explicit unavailable-context instruction; no fallback to Hermes or stale cached context.

Set `PI_MEITAN_HOME` to another **absolute** directory if needed. This repo contains code, not personal context; it never creates or edits your context files. The initial local migration copied Hermes files without changing the originals; future changes are not synchronized. Journal stays at `~/workspace/meitan_journal`.

## OptMem

Uses `~/.optmem/memo`, or `PI_OPTMEM_MEMO` (executable path, not a shell command). Inherits OptMem's `MEMORY_DIR`; it does not create a new memory store. The `memo` tool accepts an argument array for wake, note, nap, recall, zoom, and read-only config. Execution is shell-free, cancellable, and limited to 30 seconds. Output is capped at 2000 lines / 50 KB.

The model is instructed to wake before work after enable/start/reload/tree/compaction, complete pagination and requested compression, and consider saving only useful nonredundant facts before its final answer. Wake/nap sequencing is prompt guidance, not a hard tool gate. No startup subprocess, direct automated memory writes, or shutdown notes. Administrative commands remain outside the tool. Disabling removes the tool and its injected instructions; execute also checks the toggle.

After a normal completed answer, OptMem checks the active session branch since the latest user message for a `memo` tool call with `args[0] === "note"`. If none exists, it queues one hidden, extension-authored memory-review follow-up (not an impersonated user message). This adds model work after the initial answer has already streamed; the model may save nothing and is instructed not to repeat the answer or resume project work. The reminder is hidden, not its subsequent model/tool activity. This is a reminder, not a semantic classifier or a guarantee that a memory is saved.

A branch-local request marker prevents recursive reminders and survives reload/resume/compaction. Earlier requests' saves do not suppress later reviews. Any note *attempt* suppresses the reminder, including failed/interrupted writes that might have landed; it never encourages an automatic write retry. Wake/recall/nap calls and text merely mentioning `memo note` do not count. Errors, cancellation, truncation, terminating tool batches and already-pending messages suppress follow-up injection. Nothing runs on session shutdown. Subagents remain instructed not to use memory. `/reload` or a new pi process loads changes; existing processes do not hot-update automatically.

**Off is not a privacy sandbox or amnesia:** ordinary bash/read tools can still reach local files, and prior tool outputs, responses, or summaries remain in conversation history. Use a new session to avoid historical influence. Model/provider behavior still affects personality; pi's coding instructions remain intact.

## Native memory migration (offline staging)

The native store now has an offline OptMem snapshot importer, dry-run reports,
versioned export/restore, unassigned candidate review, separate classification and
acceptance, and confirmed purge with anti-resurrection tombstones. No live data is
imported automatically and no native memory tool or backend switch is enabled yet.
Workpad remains in-session working context; durable memory is out-of-session.
See [migration steps and remaining cutover gates](docs/memory-migration.md),
[store contract](docs/memory-store.md), and [roadmap](docs/ROADMAP.md).

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
New/forked sessions start detached. Independent of personality and OptMem.
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

Tests use temporary context/history and a mocked pi API, plus a component-level model-picker test; they do not read/write personal memory or call a model. On the original machine, installation of the exact already-installed pi 0.85.1 required `bun install --minimum-release-age=0` because it was newer than the local release-age policy.

Uninstall: `pi remove ~/workspace/pi-generalist-extensions`, then `/reload`. Personal context and memory are retained.
