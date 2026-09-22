# Generalist pi extensions

Independent, opt-in personality and compact memory extensions for pi 0.85.1 (@earendil-works distribution).

## Install / use

```sh
pi install ~/workspace/pi-generalist-extensions
```

Run `/reload` in an existing pi session, or start a new one. The bundled **Meitan** theme is then available from `/settings`; select `meitan` (or launch once with `pi --use-theme meitan`). It carries the forest-green palette from the local Hermes skin, but it is independent of the personality toggle.

- `/meitan [on|off|status]`: toggle personality; no argument flips it.
- `/memory`: native memory status; `/memory configure`, `/memory on`, `/memory off`, `/memory context` and review controls.
- `/generalist`: bundle settings, including default personal memory, Meitan pairing preference, the housekeeping model, and output format. In its TUI, `Ctrl+S` saves the current Meitan, memory, output, patch, footer-icon, and small/background-model choices as global defaults in `~/.pi/agent/extensions/generalist-settings.json`; current branch choices still win. A saved memory-on preference creates a fresh grant against the current native-memory config and scopes, failing closed if validation fails. Existing branch grants suspend when their bound config changes. Extension results use readable plain text by default; `/generalist output on` enables branch-local raw JSON diagnostics (`output off` restores readable text). `/generalist companion` explicitly enables Meitan + default memory; `/generalist personal` and `/generalist pairing` configure the remembered defaults. Individual `meitan on|off|toggle` and `memory on|off|toggle` controls remain independent.
- `/generalist patch on|off|toggle` (also `/patch on|off|status`, or `pi --patch`): optional Codex-style `apply_patch` tool, off by default. Add/update/delete/move local project files with preflight, tolerant matching, and explicit partial-failure reports. Built-in `edit` remains available. See [patch syntax, limits, and guarantees](docs/apply-patch.md).
- `/status-icons [on|off|status]` (or `/generalist icons on|off|toggle`): show every Generalist footer boolean as a labelled check/cross (for example, `meitan: ✓` or `meitan: ✗`) instead of only showing enabled `name: on` labels. This is branch-local and off by default. Pi sends Unicode verbatim; terminals/fonts that lack those glyphs show their own fallback, so this does not require or attempt to detect Nerd Fonts.
- `/tasks [clear]`: view or clear the branch-local task checklist.
- `/bg-tasks [list|status ID|output ID|cancel ID]`: inspect finite Linux commands launched with `bg_tasks`. The model tool can also wait for the next/all active jobs, cancel all, or ignore selected/all results. Jobs are session-bound and stop on reload, session replacement, and graceful Pi exit.
- `/subagents`: model-free live inspection of owned SDK workers (read-only by default, opt-in `permissions:"implement"` for edits and shell tests in the shared checkout); `/subagents stop` cancels them. The agent uses `subagents` for explicit fresh/fork starts, peeking, clarification, joining and report collection. Fork requires a compatible Pi snapshot hook and human history-sharing grant. See [the implemented contract](docs/subagents.md).
- `/generalist background`: select or clear the **Small/background model** (also in `/generalist`); `background status` inspects it and `background clear` clears it. Uses the existing Pi model catalogue, including configured local models, without refresh or connection checks. Selection is branch-local; reopen `/generalist` and press `Ctrl+S` to save it for new sessions. Configuration only: no calls, server launches, foreground-model changes, fallback, or consumers. Memory housekeeping and subagents remain independent.
- `/questions [list|clear]`: answer, inspect, or discard asynchronously queued questions; `Ctrl+Shift+Q` opens the oldest batch.
- `tool_feedback`: let the model report tool behavior, usability, limitations, or design concerns, including friction when a tool call succeeds. Each report is saved as a private, immutable JSON file under `~/.pi/agent/tool-feedback/`; only the supplied report fields and timestamp are recorded, with no automatic transcript capture or external sending.
- `pi --meitan`: enable personality initially. `--memory-config /absolute/config.json` selects native configuration but does not enable memory.

Both default off. Native memory requires an explicitly configured store and a project mapping or opted-in default personal profile, plus a human activation decision. Memory grants are session/cwd/config-bound: reload/resume/tree restore them; new sessions use the memory default explicitly saved with `Ctrl+S` in `/generalist`, while forks retain branch-local policy semantics. `/memory off` immediately blocks new captures and recall; other changes wait for idle. Personality retains its existing branch/CLI behavior. Enabled features appear in the footer. `/status-icons on` shows labelled `✓`/`✗` states for all Generalist feature booleans; disable it to show only enabled ASCII labels.

## Startup questions

A fresh interactive `pi` (or `/new` in an unconfigured launch) asks, in order:

1. **Personality / memory:** plain coding, coding + native memory, Meitan only, or Meitan + native memory. Memory requires `/memory configure` first; unavailable configuration warns without blocking model selection.
2. **Model / thinking preset:** recently used combinations, keep the current combination, or choose another model and thinking level. The model browser supports typing to filter; thinking choices reflect the selected model's supported levels.

The eight most recently used model/thinking combinations appear first, newest first. Choosing one promotes it; combinations actually used after `/model` or thinking changes are also remembered. History lives in `~/.pi/agent/generalist-model-history.json` (under pi's agent directory when overridden), shared across projects. It stores only provider/model IDs and thinking levels—not credentials or conversation content. Writes are atomic and best-effort; simultaneous pi processes may race on recency. Unavailable, out-of-scope, and no-longer-supported combinations are hidden. Pi's configured default model/thinking settings are **not** changed, and previous choices are never applied silently to a new session.

No automatic questions for resumed/forked/saved sessions, `/reload`, print/JSON/RPC mode, or launches with explicit model/provider/thinking/scoped-model/preset/toggle flags (including Kouseki launches). Initial prompts/files and unknown launcher switches also suppress the picker conservatively. Ordinary name, extension/resource, offline, and terminal-display options are allowed. `pi --no-session-setup` explicitly skips startup questions.

Use **`/session-setup`** to open both steps manually in an interactive session, even when launch flags suppressed startup. Existing `/meitan`, `/memory`, and `/model` commands still work independently. Cancel the first question to keep everything unchanged; cancel model selection to keep the chosen personality/memory but leave model/thinking unchanged. No automatic re-prompt on reload. History errors warn without blocking session choices; delete a corrupt history file to reset recents.

The package loads `extensions/generalist.ts`, which initializes both independent features before the picker. `meitan.ts` and `memory.ts` also work as standalone extensions without startup questions; don't load them separately alongside the package.

## Background jobs

`bg_tasks` starts an explicitly requested finite local command and returns promptly with a job ID. It can list jobs, read bounded output pages with cursors, report execution/cleanup facts, and cancel only jobs owned by the current Pi runtime. `wait` uses `waitFor: "next" | "all"` over the jobs active when the call begins (bounded by `seconds`, default 60); jobs started later are not added to that wait. `ignore` leaves a job running but permanently changes its completion policy to `notify: "off"`; both ignore and cancel accept an ID or explicit `all: true`. If the model tries to finish while an attended job remains active, a follow-up prompt requires it to cancel, ignore, or wait rather than silently abandoning the job. On `start`, `notify: "errors"` keeps clean exit-zero completion quiet while still waking on failures; `notify: "off"` suppresses all completion wakes without discarding the result or output and counts as an explicit ignore disposition. Commands use `/bin/bash --noprofile --norc -c` with closed stdin and are currently Linux-only. A job stops on `/reload`, session replacement, or graceful Pi exit; a crash/reboot leaves only an incomplete record and is never treated as successful recovery. The first version does not manage services, watches, PTYs, remote execution, schedules, retries, or jobs from print/JSON mode. See [the contract and limits](docs/bg-tasks-proposal.md).

## Agent switchboard

Switchboard automatically registers interactive Pi sessions after `/reload`, with
same-project roster observations and pending-mail hints at existing model requests.
When alone it adds no roster context; incoming presence/mail never wakes an idle model. The footer
separates other registered participants (`peers`) from direct registered children
(`sub`), rather than counting the current session. `/switchboard` opens the
roster/inbox, and the `switchboard` tool supports addressed correspondence
and interruptible `wait` for mail/user input. `/reload-all` queues a reload for every
currently connected switchboard agent and this session; reloads are delivered
programmatically as follow-ups, so they wait for active work to settle and require
no agent tool call. Newer-daemon detection now queues an automatic reload once
idle (one attempt per protocol version; old pre-fix sessions need one manual reload).
`/switchboard mail [N]` peeks at all pending incoming mail plus the latest N
acknowledged/expired entries (default 50), without fetch/ack receipts or model calls.
`/switchboard status` includes bounded daemon lifecycle diagnostics.
A small per-user Linux helper starts
on demand (Node 24+ and `flock`), with no systemd installation or inference.

`/switchboard dashboard` or `/generalist dashboard` opens the live searchable
roster/inbox/offers desk. Human task offers require explicit acceptance and a separate
confirmed Start; no automatic session replacement or worker launch. See the
[dashboard and interactive-offer contract](docs/switchboard-dashboard.md).

**Opt out:** `PI_SWITCHBOARD=off` before launch (no registration/storage),
`/switchboard off` for this session, or `/switchboard project-off` for the project.
`/switchboard manual` keeps human observability but suppresses new automatic
context. Names and explicitly supplied summaries are public to local participants;
no transcripts or automatic trace summaries are collected. Workers can use scoped
participant capabilities. The separate [subagent runner](docs/subagents.md)
now owns launch, join, cancellation and reports; switchboard itself remains identity
and correspondence, not execution authority. Automatic reloads defer while owned
workers are active. See [commands, privacy, limits and validation](docs/switchboard.md).

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
recall is bounded, request-frozen and inspectable with `/memory context`. Local
scope-aware lexical ranking supplies zero to three qualifying notes by default
(plus eligible human pins), with a small preceding-user topic hint for apparent
follow-ups. Weak matches are omitted; no embeddings or extra model calls are needed.
Earlier packets remain at their original conversation boundaries. Candidates
and unassigned records are never automatically recalled. An opted-in default personal
profile supplies cross-project context even in unmapped directories; mapped project
exceptions take precedence without hiding unrelated personal context. `/memory profile
project` excludes personal memory; `/memory profile default` restores the combined
profile. Existing project-only branch choices remain project-only until changed. Ordinary recall/reindexing is local;
the active agent authors notes. No automatic compression, reminder or shutdown save.

Optional **Memory housekeeping model** in `/generalist` (or `/generalist housekeeping`)
selects a separate provider/model for manual, read-only review. After configuration,
`/memory housekeep ID [ID…]` asks permission to send up to eight selected records.
It returns cleanup/classification suggestions without modifying memory or involving
the active conversation. Default off; no model fallback or automatic scheduling.

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
