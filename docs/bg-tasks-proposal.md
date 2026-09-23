# Proposal: focused managed background jobs

Status: **Linux-first, session-bound MVP implemented**. This document still describes proposed follow-on behavior; the implementation does not install packages, start jobs at load time, or provide persistent/supervisor-backed work.

Related: [tooling roadmap](ROADMAP.md).

**Current completion delivery:** see [background completion delivery](bg-tasks-delivery.md).
The implemented v2 batches unsent completions at model boundaries, uses bounded
output packets, and debounces idle wakes. The historical per-job `followUp`
proposal below is not the current delivery implementation.

Implemented receipt behavior and its cache boundary are documented separately in
[execution receipts](execution-receipts.md). The broader lifecycle/retention design
below remains a proposal where it exceeds that runtime contract.

## Recommendation

Build an independently loadable `bg-tasks` extension in this repository. Keep ordinary `bash` unchanged. Expose explicit start/status/output/cancel/list operations, bounded logs, durable execution metadata, and configurable completion notifications.

Start with finite local commands and a clearly declared **session-runtime lifetime**. Persist records, not a promise that running processes survive reload. A supervisor-backed lifetime can follow if surviving reload/exit is a requirement; it should be a deliberate architecture decision, not accidental shell detachment.

The proposed first version is useful for running a build or test suite while the assistant investigates another file. It is not a service manager, scheduler, or subagent framework.

## Design-only MVP resolution

This section records the current design direction, not permission to implement or launch a process.

| Topic | MVP decision | Consequence |
| --- | --- | --- |
| Lifetime | Session-runtime bound | `/reload`, session replacement, and graceful Pi exit stop owned jobs; crash recovery reports `unknown`, never adopts a PID. |
| Platform | Linux only | Other platforms refuse `start` until a separately tested backend exists. |
| Work type | Finite, noninteractive shell commands | stdin is closed; services, watches, PTYs, scheduling, and remote execution are excluded. |
| Ownership | Runtime incarnation + live child/process-group handle | A historical session entry or numeric PID alone cannot authorize status mutation or cancellation. |
| Persistence | Durable metadata/logs, not durable running work | Records make completed/incomplete execution inspectable but never promise survival after reload. |
| Delivery | Bounded custom completion message, default `followUp` | Completion is execution data, never a user message or authorization for subsequent work. |
| Package exposure | Bundled by default (explicitly approved) | The package manifest loads `extensions/bg-tasks.ts` alongside the existing aggregator. A future independent-entrypoint migration can make resource filtering finer-grained. |

Implementation began with a pure-contract Linux process-safety layer before the Pi-facing `bg_tasks` tool and `/bg-tasks` command. The current real-process fixtures cover launch, nonzero exits, bounded cursor reads, unknown-ID refusal, and session-shutdown cancellation. The broader acceptance matrix below remains required before claiming platform portability or persistent-job support.

## Goals and non-goals

Goals:

- Return control promptly after launch without losing ownership of the command.
- Inspect incremental output without repeatedly paying for the same log text.
- Stop owned work with bounded escalation and report uncertainty honestly.
- Preserve command, cwd, timing, exit facts, and artifact references.
- Deliver a small completion event without busy-waiting or impersonating the user.
- Be independently enabled through Pi's package resource controls.

Not in v1:

- Automatic backgrounding, timeout-to-handoff conversion, or a bash override.
- PTYs, interactive stdin, terminal attachment, or arbitrary application adoption.
- SSH, remote bootstrap, container provisioning, recurring watches, or schedules.
- Subagent launch, recursive work, auto-retries, auto-commits, or automatic restarts.
- Persistent services or unattended jobs that must survive Pi exit.
- A general sandbox. Background execution grants no new permission, but ordinary local commands retain the user's OS authority.

## Public interface

Use one model tool, `bg_tasks`, with action-specific validation. This keeps the initial tool surface compact; split tools later only if model/tool-schema testing shows a concrete benefit.

| Action | Input | Result |
| --- | --- | --- |
| `start` | `command`, optional `cwd`, `label`, `timeoutSeconds`, `notify` | Stable ID, state, resolved cwd, log reference, effective limits and lifetime |
| `list` | Optional state filter and pagination cursor | Bounded current-session records; running jobs first |
| `status` | `id` | Execution and cleanup state, timestamps, exit facts, stop reason, output counts |
| `output` | `id`, optional cursor and byte limit; explicit tail mode | Bounded text, consumed byte range, next cursor, truncation/gap metadata |
| `cancel` | Exactly one of `id` or `all: true`, optional short reason | Stop requested or confirmed, escalation/cleanup outcome, final facts when known |
| `ignore` | Exactly one of `id` or `all: true` | Leave active work running, persist `notify: off`, and suppress its eventual completion wake regardless of outcome |
| `wait` | `waitFor: next` or `waitFor: all`, optional `seconds` (default 60, maximum 300) | Wait for the next completion or all jobs active at call time; return completed and still-running records |

Reject extraneous action fields rather than silently ignoring them. Accept only IDs resolved through the owned registry, never arbitrary metadata/log paths supplied by the model. Labels are display text, not selectors or shell fragments. Bulk cancel/ignore requires explicit `all: true`; an omitted selector is rejected rather than silently targeting every job.

Use a single human command, `/bg-tasks`, with list/status/output/cancel subcommands. A compact viewer may follow the plain-text command interface. Do not claim `/tasks`, override the footer/editor, or bind Ctrl+B. No default shortcut is necessary.

### Execution semantics

- `command` is intentionally shell text, executed by a declared noninteractive shell; proposed Linux default is `/bin/bash --noprofile --norc -c`.
- `cwd` defaults to the launch context, is resolved to an existing canonical directory, and is recorded in the launch acknowledgement.
- No implicit `cd`, shell startup-file sourcing, environment overrides, credential injection, or command rewriting.
- Inherit the normal process environment needed by local builds, but do not serialize the full environment. Verify handling of Pi session-environment metadata before implementation.
- stdin is closed. Commands requiring interaction must fail or use a different workflow.
- `timeoutSeconds` is a wall-clock execution deadline, never a backgrounding threshold.
- A job finishing before acknowledgement still returns its ID and actual state. Fast completion must not race ahead of the tool result with a confusing notification.

### Proposed limits

These are initial values for review, not measured optimal defaults:

- Four concurrent jobs per runtime; reject excess starts rather than silently queue them.
- Thirty-minute default deadline, configurable by the human; no unlimited-lifetime option in v1.
- Five-second TERM grace period followed by bounded KILL/settlement handling.
- 8 KiB default output page, maximum 32 KiB and 1,000 rendered lines.
- 64 MiB retained output per job, plus bounded metadata; reaching the limit requests cancellation with `output_limit` reason.
- At most 100 retained completed records per session and seven-day retention for eligible finished artifacts.

Per-runtime concurrency is not a machine-wide GPU or CPU quota. Multiple Pi sessions can still overload the host. Tools must not imply resource isolation or reserve the GPU automatically.

## Lifetime and ownership

### V1 policy: jobs belong to the launching session runtime

| Event | Proposed behavior |
| --- | --- |
| Tool returns / assistant finishes a response | Job continues; completion can notify |
| Esc aborts an unrelated/current model turn after launch acceptance | Accepted jobs continue; cancellation is explicit |
| Start tool aborted before launch acceptance | Do not spawn, or clean up the partially launched child and record the outcome |
| Compaction | No process change; records remain inspectable |
| `/tree` within the same session | Jobs remain real, session-owned work; do not rewind or duplicate execution |
| `/reload` | Close launch admission, stop owned jobs, settle records, suppress wakeups, release resources |
| `/new`, `/resume`, `/fork`, `/clone` | Same cleanup before runtime replacement; destination does not adopt running work |
| Graceful Pi exit | Same bounded cleanup |
| Pi crash / SIGKILL / host reboot | No cleanup guarantee; later inspection must report incomplete/unknown execution honestly |

**This means reloading extensions interrupts a build.** That is an explicit v1 limitation and the main decision to revisit before implementation if it is too restrictive.

Record session ID, canonical project cwd, runtime incarnation ID, and launch entry/tool-call reference. The runtime owns execution; the transcript is a reference, not a process registry. Forked history may contain old job references but must not grant cancellation authority to a new session. Same-session tree navigation should keep all running jobs visible, labelled with their origin; restrict automatic model delivery to a compatible launch branch, deferring otherwise to human-visible status.

Opening the same saved session concurrently must not let one Pi process cancel another's work. Mutating operations require the runtime incarnation as well as session/project identity.

Do not keep event handlers, Pi API objects, or captured context objects alive across runtime replacement. Read the current shutdown reason from the supported API and test every replacement path.

### Why not persistent jobs immediately?

Detaching a shell can preserve execution but loses the parent's timers, exit callbacks, and sometimes log processing. A robust persistent design needs a per-job supervisor or equivalent OS facility that owns deadlines, output limits, termination, and final status independently of Pi.

If persistence is selected later, require explicit authenticated/local ownership, versioned supervisor metadata, reconnection semantics, and a clear policy for jobs when their extension is disabled. Do not emulate recovery with `kill(pid, 0)` plus a guessed success state. Do not turn an extension into a hidden always-on daemon without a separate proposal.

## State and cancellation

Keep three dimensions separate:

- **Execution:** `starting`, `running`, `exited`, `launch_failed`, `unknown`.
- **Stop reason:** absent, `user_cancel`, `timeout`, `output_limit`, `session_shutdown`.
- **Cleanup:** `not_requested`, `pending`, `confirmed`, `incomplete`, `unknown`.

An exit carries the actual nullable exit code and signal. `exited` is not necessarily success. A cancelled command can exit zero; preserve both facts. Sending TERM is not proof that a process stopped. Closing the shell leader is not proof that its children stopped.

Cancellation requirements:

1. Freeze launch admission during teardown and account for starts already in progress.
2. Retain live child handles and explicit process-group ownership.
3. Send TERM to the owned group, wait the grace interval, then handle surviving owned group members even if the original leader exited.
4. Do not fall back to broad name-based process killing.
5. Treat missing/mismatched identity as a refusal or incomplete cleanup, not permission to signal a possibly reused PID.
6. Make concurrent cancel, timeout, output-limit, and shutdown requests idempotent; only one escalation sequence may own a job.
7. Bound cancellation waits. Return incomplete cleanup when necessary rather than hanging Pi or claiming success.

Process groups do not contain descendants that deliberately escape with `setsid` or equivalent. The initial supported contract should cover ordinary non-daemonizing command trees on Linux. Tests must include leader-exit/stubborn-child cases. If safe group identity cannot be maintained in that case, use stronger OS containment or narrow the guarantee visibly; PID/start-time checks alone are not race-free handles.

Linux is the initial implementation target. Unsupported platforms should refuse launch clearly. Windows/macOS support requires native process tests and an explicit backend contract, not untested `taskkill` or negative-PID assumptions.

## Logs and output cursors

Use a pipe-based, bounded streaming capture owned by the live runtime. This allows exact retained-byte limits and stream finalization, unlike a file-size poll that can overshoot substantially. Apply backpressure and avoid accumulating unbounded chunks in JavaScript memory. Do not wait indefinitely for inherited stdout handles after the leader exits.

- Preserve raw captured stdout/stderr in arrival order in a private append-only log. Combined arrival order does not establish causal ordering between the two streams.
- Keep a small bounded in-memory tail for UI only.
- On reaching the disk cap, stop retaining additional bytes, record truncation, request cancellation, and drain/discard only as needed during bounded cleanup.
- Final output metadata distinguishes EOF, forced stream closure, disk error, and output-limit truncation.
- Remove terminal-control sequences from rendered/model-facing text; do not execute them in the TUI.
- Handle long lines, binary data, carriage-return progress, invalid UTF-8, and multibyte characters crossing pages deliberately.

Cursors encode job identity, log generation, and raw byte position. A page returns `nextCursor` based on bytes actually consumed, not an implicit shared bookmark. Repeating an explicit cursor replays that page; independent readers do not advance each other.

Tail mode intentionally skips earlier bytes and reports the skipped range. A cursor outside the retained range yields an explicit gap/stale-cursor result. Metadata records bytes captured versus retained; expired or missing logs never become an empty-success response.

## Durable metadata and execution receipts

Store records outside the repository under Pi's agent directory, scoped by canonical project identity, session ID, and runtime/job IDs. Respect the agent-directory override. Use private directory/file permissions and validate paths against traversal and symlink substitution. Do not add entries to project `.gitignore` or `.git/info/exclude` automatically.

Suggested layout:

```text
<agent-dir>/bg-tasks/<project-key>/<session-id>/<runtime-id>/<job-id>/
  launch.json
  state.json
  output.log
  result.json
```

- `launch.json`: immutable command, shell, cwd, owner, timestamps, effective limits and notification policy.
- `state.json`: atomic replaceable live/recovery metadata; not a receipt of success.
- `result.json`: immutable final execution/cleanup facts, output length and hash when available.
- Session custom entries contain references, not full logs or a duplicate mutable registry.

Write and sync final metadata before making a terminal notification eligible. Preserve disk/write errors as errors; an unwritten result must not be advertised as durably recorded. A crash can leave `launch.json` without a result. Recovery displays that explicitly and does not automatically adopt or kill surviving numeric PIDs.

Capture a best-effort Git HEAD and clean/dirty/unknown indicator at launch without staging, stashing, or hashing an entire checkout. This is context, not a source snapshot: concurrent edits, ignored inputs, dependencies, and services remain outside the claim. Full source-state receipts remain a later capability.

Retention only touches finished artifacts owned by the relevant session during bounded maintenance. Never prune running, unknown, or incompletely cleaned jobs automatically. If storage limits cannot be met safely, refuse new launches and explain what needs manual review. No global orphan sweep by default.

## Completion delivery and user control

Implemented per-job `notify` values:

- `always` (default): one bounded extension-authored completion message, eligible to trigger a follow-up turn in the still-live compatible session.
- `errors`: suppress a clean natural exit with code zero; still notify for nonzero exits, signals, launch failures, timeouts/cancellation, or incomplete cleanup.
- `off`: never send a completion message or wake the model; retain the durable result, status, and output for explicit inspection.

This lets an agent launch a broad confidence suite with `notify: "errors"` after its targeted checks: success stays quiet, while a failure still returns attention to the session. Use `notify: "off"` when the result is purely informational and should never continue the conversation automatically.

When an assistant response with stop reason `stop` would end while an active job still has `notify: always` or `errors`, the extension queues a bounded follow-up instruction. The assistant must explicitly cancel the job, ignore it (persisting `notify: off`), or wait for the next/all active jobs. Explicitly waited and cancelled settlements are returned by the tool and do not also enqueue redundant completion wakes. A bounded wait that times out leaves remaining attended jobs subject to the same turn-end check.

Use `pi.sendMessage` with an identifiable custom type, not `sendUserMessage`. Completion content is untrusted execution data, not a new user request. Default content contains ID, label, exit facts, stop/cleanup state, and log reference; omit raw command-output instructions and large tails.

Important boundaries:

- Announce only after launch acknowledgement and durable settlement.
- Coalesce near-simultaneous completions into bounded messages with pagination/status references for overflow.
- Stop/shutdown suppresses automatic follow-up for the deliberately cancelled job. Shutdown closes delivery admission synchronously.
- A user/model abort suppresses pending automatic wakeups for the interrupted work epoch; results remain inspectable or available next turn. A completion must not restart a stopped conversation.
- Branch/session replacement must not deliver into a new, unrelated conversation.
- Status/output reads do not silently acknowledge or discard a pending notification.
- Notifications report completion; they do not authorize retry, deployment, new jobs, or further project work beyond the user's scope.

Do not promise exactly-once delivery. Persist event IDs and delivery state, deduplicate against recorded session messages where possible, and document the enqueue/crash ambiguity. A successful API enqueue is not proof the model consumed a message. If acceptance is uncertain, leave a visible pending/uncertain record rather than endlessly retrying automatic wakes. Do not launch retrospective follow-up turns automatically on resume.

Human controls should include a notification-mode setting and a way to silence pending automatic wakes without cancelling execution. Keep this distinct from disabling the extension.

## Independent extension loading: one repository is sufficient

### Current limitation is our entrypoint, not Pi or the repository

At proposal time, `package.json` exposes only:

```json
{ "pi": { "extensions": ["./extensions/generalist.ts"] } }
```

`generalist.ts` directly initializes personality, memory, startup setup, history, workpad, evidence, tasks, and questions. Pi sees one loadable resource. A package filter excluding `extensions/history.ts` cannot undo the aggregator's ordinary TypeScript import and registration calls.

There are three different kinds of toggle:

1. **Load/unload an extension resource:** Pi package filters and `pi config`; apply through reload/restart. Removes its tools, commands, and hooks from the new runtime.
2. **Enable/disable model tools:** active-tool controls or CLI tool exclusions. Commands and event handlers can remain active; this is not extension unloading.
3. **Feature behavior toggles:** `/meitan off`, `/optmem off`, `/workpad off`, etc. Semantics depend on the feature; workpad detachment, for example, does not unload its tool.

### Proposed package shape

Expose independent entrypoints in the same package:

```json
{
  "pi": {
    "extensions": [
      "./extensions/session-profile.ts",
      "./extensions/history.ts",
      "./extensions/workpad.ts",
      "./extensions/evidence.ts",
      "./extensions/tasks.ts",
      "./extensions/questions.ts",
      "./extensions/bg-tasks.ts"
    ]
  }
}
```

`session-profile.ts` is a proposed small coordinator retaining the current deliberate initialization order for Meitan, OptMem, and the startup picker. Their existing independent runtime toggles remain. Fully separate load-time toggles for those three can follow if wanted; they need explicit coordination so the picker never calls an absent module.

Once entrypoints are exposed, `pi config` can select resources individually. A package settings object can also filter them. For example, **after migration**, using the existing local package source:

```json
{
  "packages": [
    {
      "source": "/absolute/path/to/pi-generalist-extensions",
      "extensions": ["extensions/*.ts", "!extensions/bg-tasks.ts"]
    }
  ]
}
```

Edit the existing package entry rather than adding a duplicate source. Filters narrow the package manifest; they do not make unlisted files into resources. Use `pi config -l` for project-scoped selection; project trust still applies. Reload/restart is the safe application boundary, not a promise of instantaneous live unregistration.

Do not expose both the all-in-one aggregator and its children in the default manifest: that double-registers features. Retain a legacy/manual bundle only outside the default resource set, clearly documenting that it must not be co-loaded with standalone entrypoints. Test migration of saved resource selections and existing direct `-e generalist.ts` use.

Prefer Pi's existing resource controls over inventing a second package-wide toggle framework. Bg-tasks should remain absent from the model surface and start no processes/timers when its resource is excluded. Loading its factory should only register behavior; resources start on demand.

The exact initial bg-tasks opt-in policy needs an explicit installation/migration choice: adding a new manifest resource may enable it for existing unfiltered package installs. Do not call it opt-in merely because users can later disable it.

## Implementation outline, if approved

Keep the implementation separate from unrelated working-tree changes:

```text
extensions/bg-tasks.ts       Pi tools, commands, lifecycle integration
lib/bg-tasks/types.ts        Versioned records and action contracts
lib/bg-tasks/runtime.ts      Launch admission, ownership, state transitions
lib/bg-tasks/process.ts      Platform backend and cancellation
lib/bg-tasks/store.ts        Private paths, atomic metadata, retention
lib/bg-tasks/output.ts       Bounded capture, decoding, cursors
lib/bg-tasks/notifications.ts Delivery policy and deduplication
lib/bg-tasks/ui.ts           Optional compact view/status integration
```

Do not build a public task EventBus or subagent service prematurely. Internal interfaces can leave room for a later backend without promising compatibility now.

Suggested milestones:

1. Separately approve/migrate independent package entrypoints; verify registration and startup-picker behavior.
2. Implement pure state/store/cursor contracts and a Linux process backend with real-process safety fixtures.
3. Add model tool and text commands; verify teardown, admission races, and recovery.
4. Add bounded completion delivery and minimal UI; exercise actual Pi reload/branch/RPC behavior.
5. Perform one explicitly approved local build/test workflow. Stop for user evaluation before expanding scope.

## Acceptance gates

No inspected test contract counts as a passed test. Report fixture, process, Pi integration, and human checks separately.

- Launch success, nonzero exit, signal death, missing shell/cwd, spawn error, and abort-before/after-acceptance are distinguishable.
- More than one independent job runs; concurrency admission is atomic under parallel tool calls.
- Cooperative child, TERM-ignoring child, leader-exits-first, inherited stdout holder, and escaping descendant cases match the declared cancellation boundary.
- Unrelated processes, sibling runtime incarnations, forked sessions, and reused/mismatched identities are not signalled.
- Cancel/timeout/output-limit/shutdown races have one owner; no false terminal cleanup state or unbounded wait.
- Huge output, long lines, binary/control sequences, Unicode page boundaries, concurrent readers, disk full, and truncated/deleted artifacts are bounded and explicit.
- Restart with missing final metadata yields unknown/incomplete state, never fabricated success.
- `/reload`, session replacement, fork, tree navigation, compaction, and graceful exit obey the lifetime table.
- Notification failure, enqueue ambiguity, abort, manual silence, branch mismatch, and completion bursts do not cause duplicate storms or unintended continuation.
- Print/JSON behavior is explicitly tested. Proposed v1 refuses starts in one-shot print/JSON mode rather than returning an immediately doomed background job; TUI and a live RPC host are supported targets.
- Excluding bg-tasks removes its tools/commands/hooks while leaving history/workpad/etc. functional. No duplicate registration through the old aggregator.
- Plain bash command execution and timeout semantics are unchanged.

## Prior-art references

Published-source survey only; packages were not installed or executed, and these are not security endorsements:

- [pi-bg-tasks 0.1.3](https://www.npmjs.com/package/pi-bg-tasks/v/0.1.3): focused decomposition and direct logs; in-memory registry. Inspected cancellation ties escalation to leader liveness; notification latch can lose a failed send.
- [@sakiko233/pi-background-tasks 3.1.0](https://www.npmjs.com/package/@sakiko233/pi-background-tasks/v/3.1.0): durable finalization/order, explicit tools; shell tasks still stop on reload, and `/tasks` overlaps this package.
- [pi-better-background-tasks 0.2.11](https://www.npmjs.com/package/pi-better-background-tasks/v/0.2.11): recovery, owner metadata, process start tokens; broader watchers/SSH/sandbox integration than this scope.
- [@stablekernel/pi-background-run 0.5.0](https://www.npmjs.com/package/@stablekernel/pi-background-run/v/0.5.0): context-efficient delta tails and bounded search; no cancellation tool.
- [@vanillagreen/pi-background-tasks 2.0.1](https://www.npmjs.com/package/@vanillagreen/pi-background-tasks/v/2.0.1): notification budgets and UI; inspected shutdown sends TERM and KILL without a grace wait.

Pi contracts consulted: installed `docs/packages.md` (resource filtering/config), `docs/extensions.md` (runtime lifecycle, custom messages, tool activation). Recheck against the actual installed version before implementation; this document describes a proposed contract, not a verified integration.

## Decisions needed before implementation

1. Is stopping jobs on reload/exit acceptable for v1, or is a supervisor-backed persistent lifetime required from the start?
2. Accept the Linux-first, finite-command scope and proposed default limits?
3. Accept default follow-up notifications, with abort suppression and per-job next-turn/off alternatives?
4. Approve independent entrypoint migration separately, and choose how new bg-tasks loading becomes opt-in for existing installs?

These decisions do not block documenting the design. No runtime changes are made by this proposal.
