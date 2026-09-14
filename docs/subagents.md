# Owned inspect subagents

This is the implemented contract. [The proposal](subagents-proposal.md) remains the
broader design, not a claim that every planned UI, editing, or lifecycle feature ships.

## For the main agent

You choose **zero, one, or several workers** according to independent work. The
concurrency ceiling is not a staffing target. Prefer a distinct investigation and
useful parent work over delegating one task and immediately waiting. One independent
review can still be valuable. You remain responsible for synthesis and verification.

The stable `subagents` tool is loaded independently of personality, memory,
continuity, Code Mode, and the task checklist. Nothing launches at registration.

```json
{"action":"start","mode":"fresh","task":"Independently inspect the cache expiration boundary; cite lines. Do not claim tests ran.","label":"boundary-review","seconds":120}
{"action":"start","mode":"fork","task":"Trace the lifecycle assumption discussed above.","label":"lifecycle-review"}
{"action":"checkpoints"}
{"action":"list"}
{"action":"status","id":"FULL_RUN_UUID"}
{"action":"peek","id":"FULL_RUN_UUID","after":0,"limit":40}
{"action":"join","ids":["FULL_RUN_UUID"],"seconds":60}
{"action":"input","id":"FULL_RUN_UUID","question":"QUESTION_UUID","text":"Assume cancellation is required on reload."}
{"action":"collect","id":"FULL_RUN_UUID"}
{"action":"cancel","id":"FULL_RUN_UUID"}
{"action":"cancel","all":true}
```

- **Start** persists intent before effects and returns while the task is starting.
  `mode`, `task`, and `label` are required. Optional `operation` is an idempotency key;
  otherwise Pi's tool-call ID is used. Same key/same intent returns the existing run,
  including failures; changed intent refuses. It never silently starts a replacement.
- **Model/provider and thinking** use the parent's exact launch-time selection.
  Workers do not choose a cheaper/different model, silently fall back, or inherit
  custom provider extensions. A model unavailable from the configured worker
  ModelRuntime fails explicitly. Actual provider-reported usage is recorded separately
  from inherited history. Cost is an SDK-reported estimate, not a billing receipt or
  hard spending guarantee.
- **Join** defaults to wait-any; `all:true` still yields for blockers/failure/user
  input. It does not collect reports or acknowledge mail. Default selection is the
  latest 16 uncollected runs; specify IDs when older work matters. Answer a blocker
  using its exact question ID. Input is not permission to reopen a finished worker.
- **Peek** returns public text/progress/tool events, not private reasoning. `next` is
  the next `after` cursor; `more` signals remaining events. Inspection has no inference,
  input, collection, or session-navigation side effects. The new worker transcript
  stays out of the parent's context unless explicitly inspected.
- **Collect** returns the structured report and a collection timestamp, not a transcript
  merge, verified evidence, repository change, or task-checklist completion. Repeated
  collection preserves the same receipt. Reports can be completed, partial, blocked,
  or inconclusive. A model stopping without a report is `incomplete`, not an invitation
  for hidden formatting retries.

## Fresh versus fork

**Fresh:** assignment, fixed worker contract, and bounded applicable repository/ancestor
instructions. No automatic parent transcript, personal system prompt, global personal
AGENTS file, memories, continuity, history tools, workpad attachment, or sibling reports.
Include relevant user constraints in the assignment.

**Fork:** a frozen, selected-branch, post-context projection captured **before the whole
assistant/tool batch requesting delegation**. The child gets that historical knowledge
plus its new assignment, not the parent's activation/custom-entry state or tool grants.
Compaction/custom-message projections are copied as selected, not recreated by reading
live sources. It does not follow subsequent parent turns or rewind source files.

Fork requires the separate [Pi observation hook](pi-context-snapshot.md). On an unpatched
Pi build it fails explicitly. There is **no silent fresh fallback** or best-effort JSONL
tail reconstruction. `checkpoints` offers only observed checkpoints retained in this
runtime, not every historical tree entry. `from` may select one of those anchors on the
current branch. Shelf limits: eight snapshots/8 MiB total, 2 MiB per snapshot. Reload
clears this observation shelf; it does not automatically reconstruct historical exports.
Failed transformations prevent default forking; later provider-payload hooks cause
rejection because fidelity past that boundary is not established.

History sharing is a **human grant**: `pi --subagent-forks`, or a blocking confirmation
when the first fork is requested. It covers all selected historical text, potentially
including private memory/continuity outputs and summaries even when those features
are now off. There is no perfect scrubber. The confirmation lasts for this parent
runtime; branch change/reload resets it unless explicitly supplied by the CLI flag.
This does not activate those features in the worker.

Each run has a fresh session ID, process, usage baseline, and origin digest/anchor.
The child session stores the frozen projection as a data entry; new child turns have
one writer. Do not resume that session expecting its historical data entry to be an
activation grant or an automatically reconstructed fork. Child takeover/resume is not
implemented.

## Inspect capabilities and limits

Workers have only `read`, `ls`, literal `grep`, `progress`, `needs_input`, and `report`.
No shell, execution tests, edits, recursive spawn, arbitrary extensions, memory,
continuity, or cross-harness history. Sequential execution plus a separate post-report
sibling guard prevents extra tools after reporting. The SDK turn-stop hook ends
inference; a `terminate` return alone is not relied upon.

File tools are rooted at the canonical assigned cwd. They reject parent traversal,
symlinks, hardlinks, private paths (including `.git`, `.pi`, `.meitan`, `.env`, credential
files), configured agent/runner/parent-session storage paths even when those live
inside the granted root, and binary/oversized reads. Do not put source files inside
those private storage directories. The root is **live source**, not an immutable
checkout/worktree. There is no protection against a hostile same-UID program racing
filesystem checks. This is a narrow model tool profile and an owned process boundary,
**not an OS filesystem/network sandbox**. Trusted SDK/provider code can access its
configured authentication; those credentials are never worker tool results.

| Resource | Bound |
|---|---|
| Concurrent processes | default 4; human `--subagent-limit 0..16` |
| Wall clock | default 600 s; `start.seconds` 1..1800; includes clarification |
| Responses/tools | 24 responses / 80 tool calls |
| Output per response | 4096 tokens, additionally capped by model maximum |
| Context | conservative serialized-byte estimate plus output reserve before each request; provider tokenizer can differ |
| Assignment / repository instructions | 32 KiB each; overflow refused |
| Read | regular UTF-8 file <=1 MiB; line paging, <=16 KiB output |
| Search | literal query; <=2000 entries/8 MiB scanned/80 matches; large directories refuse |
| Public event journal | <=8 MiB per run; 16 KiB pages; oversized events explicitly clipped |
| Structured report | <=8 KiB |
| Run history | <=128 records per owning session; no automatic pruning |

SDK automatic retry and compaction are disabled. Context overflow does not silently
summarize, switch models, or truncate the inherited history. Provider transport may
have its own behavior; token/cost fields are not a universal hard spending cap.

## Human observation and lifetime

`/subagents` opens a live, model-free run list. Enter inspects status, origin,
usage, report and latest bounded public events. Arrow keys select/scroll; Escape
closes the view **without stopping workers**. `/subagents stop` cancels all owned runs.
The separate footer reports live/blocked/uncollected counts.

Task state, process state, cleanup observation, report presence, and collection are
separate facts. A report can exist alongside a later process failure. A signal request
is not an observed exit. Aborting gracefully escalates to SIGTERM/SIGKILL with bounded
waiting; status remains explicit if cleanup has not been observed.

- Parent turn completion and closing peek leave children running.
- Explicit cancel/global Escape outside extension dialogs, parent abort, reload,
  session replacement, confirmed branch change and quit stop owned children.
- Automatic switchboard upgrade/reload-all handling defers while owned work remains.
- Parent IPC loss stops the worker. Normal worker completion flushes IPC and exits
  deliberately; provider keepalive sockets do not extend the task's lifetime.
- No completion-triggered idle parent model wake. Coalesced status hints are appended
  at new ordinary parent user turns, not periodically reinjected into old context or
  every tool follow-up. `join` supplies the usual tool-result continuation.

Artifacts live under `PI_SUBAGENTS_HOME`, or
`$XDG_STATE_HOME/pi-subagents` (default `~/.local/state/pi-subagents`), grouped by a hash
of the owning session ID and run UUID. Directories/files are private. Node 24+ on Linux
is required; `PI_SUBAGENTS_NODE` can pin the trusted Node executable.

An exclusive owner lock refuses concurrent runtimes for the same parent. After a
crash, inspect artifacts/process state and explicitly remove a stale `owner.lock`
only when appropriate. Recovery never steals a lock, adopts a process, kills a saved
PID, or relaunches work. Unobserved exits become `interrupted` with unknown cleanup.
Private transcripts, snapshots and results persist; deletion/archival is explicit.

## Switchboard boundary

The host reuses its existing switchboard participant; there is no second parent
registration. When available, workers use provisioned child identities with real
parent/run links. Capabilities are generated and persisted before provisioning;
protocol 6 permits exact parent/run/capability recovery before quotas and parent-scoped
retirement without resurrecting archived workers. Tokens never enter tool results.

The current worker mailbox is **presence only**. Use runner `input`, not ordinary mail
or task offers, for clarification. Worker/sibling mail tools, dashboard Runs tabs, and
full investigation-tree navigation remain later work. Switchboard opt-out is preserved;
standalone runner inspection works without registration. Human offer acceptance is
never reinterpreted as a subagent launch grant. Mailbox retirement errors are recorded
separately from process cleanup.

## Verification and remaining scope

Synthetic tests exercise actual SDK worker processes, scoped reads, compaction/custom
projection preservation, fresh usage, parked clarification, post-report sibling
blocking, keepalive shutdown, incomplete reports, zero/one/two/four workers and ceiling
rejection, deadlines, escalation, idempotency, owner locking, mailbox provisioning/
retirement, and model-free bounded UI. A real parent SDK fixture checks provider-bound
message-prefix preservation across ordinary turns, tools and reload, missing-hook
refusal, and no idle wake. These are not measurements of provider cache hits or a
physical-terminal ergonomics trial.

The first live `openai-codex/gpt-5.6-sol` fresh-worker smoke test found the synthetic
boundary bug and correctly reported inspection rather than test execution. It also
exposed an intentional-disconnect/keepalive shutdown bug; the report was retained and
the nonzero exit was correctly shown as a failure. A keepalive regression now covers
the corrected shutdown path.

**Live retest passed:** a new CLI Pi process and its single fresh worker both used
exactly `openai-codex/gpt-5.6-sol`, with no fallback. The worker identified the planted
`>` versus `>=` defect, explicitly reported static inspection, was collected, exited
with code 0, and had cleanup observed. Both synthetic source files were byte-unchanged.
Worker usage: two responses, three tools, 1585 input and 311 output tokens (SDK-reported;
not a billing receipt). Retained local artifacts: `/tmp/pi-subagents-codex-retest-p1vc02`;
run `460468f0-f1b1-4d4f-9b53-4e40b069fc88`. The earlier failed trial remains separately
under `/tmp/pi-subagents-codex-smoke-FNE9ns`; it was not relabelled as passing.

Not implemented: editing/worktrees, arbitrary worker shell tests, child resume/takeover,
survival across reload, configurable worker model overrides, a full cross-session tree,
sibling mail, automatic merges/commits, or autonomous continuation. The core fork hook
is shipped as a separate source patch; installing this package does not patch a bundled
Pi binary. Full live parent-to-worker fork validation on the user's installed build
remains gated on deploying a compatible hook-enabled Pi build.
