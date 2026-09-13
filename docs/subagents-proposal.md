# Proposal: owned subagents with forked or fresh context

Status: **design only**. No launcher, model call, new activation grant, or automatic
repository mutation is authorized by this document. This is the proposed next step
after [switchboard](switchboard.md) and [interactive offers](switchboard-dashboard.md),
not a replacement for either. It refines the earlier
[coordination](agent-coordination-proposal.md) and
[dispatcher](switchboard-dashboard-proposal.md) proposals for managed children.

## 1. What I would actually want to use

A small team of **owned, inspectable investigations**, not a swarm and not a pile of
fire-and-forget prompts. The parent keeps responsibility for the conversation,
synthesis, decisions, and integration. Children get room to investigate without
making every exploratory read part of the parent's context.

My preferred defaults:

- Make **fork** and **fresh** explicit choices. Do not silently substitute one.
- Fork when accumulated task understanding matters. Start fresh when independence
  matters: blind review, checking a disputed assumption, narrow reconnaissance.
- Start asynchronously, continue useful work, then collect or join. Never strand
  the only agent capable of answering a child's question inside an uninterruptible tool.
- Show actual tools, public progress text, elapsed time, and usage. No hidden model
  generating progress summaries, fake completion percentages, or constant status chatter.
- Let the main agent choose **zero, one, or several workers** from the actual task
  decomposition. Do not prescribe a pair or fill a fixed team. User-configured
  concurrency, runtime, and spending ceilings are limits, not staffing targets.
- Keep useful work with the parent when possible. Delegating one task and immediately
  waiting is not the default; a single independent review or context-isolating
  investigation can still justify itself without parallel parent work.
- Start with read-only investigations; add worktree-contained implementation next.
- Let a worker say **blocked**, **inconclusive**, or **the premise is wrong**. A useful
  disagreement should not be squeezed into a successful-looking completion report.

I would not require scout → planner → implementer → reviewer choreography, a
coordinator model, named specialist personalities, or automatic task decomposition.
Simple presets may save configuration, but capability grants belong to the host,
not to a Markdown role description.

The main agent decides the useful parallel width, can launch additional workers as
new independent questions emerge, and stops launching when coordination costs exceed
the benefit. Prefer distinct scopes and a useful parent lane over duplicating the
same investigation. A concurrency ceiling may refuse a start, but the host does not
invent tasks, auto-fill slots, or recruit idle peers. The user explicitly clarified
this preference during planning: worker count should be an agent decision.

### A representative workflow

```text
Parent: investigate a session-reload regression
  ├─ fork at current safe boundary: trace ownership/lifecycle
  └─ fresh: independently inspect the failing test and its assumptions
Parent: inspect integration code while both work
Child A: asks a focused question → parent join yields attention
Parent: answers; later collects both reports and resolves their disagreement
```

Alternative implementations can fork from the **same earlier checkpoint**, before
we settled on an approach. That is more interesting than merely running the next
three checklist items in parallel. Conversation origin and source-code baseline
must both be visible; going back in conversation time does not rewind the repository.

## 2. Lessons from the inspected implementations

These are observations from local source, not claims about every upstream version
or runtime tests performed for this proposal:

| Input | Keep | Deliberately do differently |
|---|---|---|
| Codex: explicit `fork_context`, spawn/input/wait/resume controls, status subscriptions | Stable child identity; nonblocking launch; wait-any; explicit context origin; inherited history is not fresh authority | Keep a smaller initial control surface; no automatic reopening of terminated workers; do not assume Codex's prompt-prefix handling transfers to Pi |
| Codex: agent overview based on already-delivered events | Observation need not attach to or take control of a worker | Use public progress/tool events, not internal reasoning, for our default peek |
| OMP: progress cards, recent tools/output, per-worker usage, result artifacts, optional async tasks and isolation | Useful live visibility and durable drill-down; separate current context size from cumulative usage | No broad shared scratch ownership, automatic patch application, or silent model fallback |
| OMP's inspected executor | SDK access is a good fit for explicit tools, events, and structured results | Despite `runSubprocess` naming, this checkout creates sessions on the main thread; use an actual process per worker here |
| Pi's bundled subagent example | Compact tool rendering, streaming, bounded parallelism | Not the whole-run blocking `pi --mode json -p --no-session` pattern; require saved session lineage, bidirectional control, and owned result records |

OMP's inspected task path builds assignment/shared context and, when IRC is off,
can write a compact parent context file. That is useful handoff machinery, but not
the branch-native fork semantics proposed here. Codex's full-history path explicitly
flushes history, handles compaction histories, and separates inherited authorization:
this is a warning that forking is not just copying the latest text.

### Source map

Snapshots inspected while planning; recheck before implementation:

- Pi checkout `d981de122`, `/mnt/secondary/workspace/pi-mono`:
  `packages/coding-agent/src/core/session-manager.ts` (`branch`,
  `createBranchedSession`, `forkFrom`), `src/core/extensions/types.ts`, and
  `examples/extensions/subagent/index.ts` under that package.
  Read the package's complete `docs/extensions.md`, `sdk.md`, `session-format.md`,
  `sessions.md`, `compaction.md`, `rpc.md`, and `tui.md`; source wins where docs differ.
- Codex checkout `ca6fb194b6`, `/mnt/secondary/workspace/codex`:
  `codex-rs/core/src/tools/handlers/multi_agents/{spawn,wait}.rs`,
  `codex-rs/core/src/agent/control.rs` and `control/spawn.rs`,
  `codex-rs/tui/src/app/agents_overview_details.rs`.
- OMP checkout `83a060396c`, `/mnt/secondary/workspace/oh-my-pi`:
  `packages/coding-agent/src/task/{index,executor,types}.ts`.
- This package: `extensions/switchboard.ts`, `lib/switchboard/{runtime,store}.ts`,
  `tests/fixtures/switchboard-sdk.ts`, and the implemented contracts linked above.
  Package development dependency is Pi `0.85.1`; the local Pi checkout and installed
  distribution must not be assumed API-identical.

## 3. Fork/fresh semantics and the investigation tree

### Fresh

A new session receives its assignment, applicable repository instructions, a fixed
worker contract, selected capabilities, and explicitly attached task material.
There is **no automatic parent transcript, history-search access, workpad attachment,
personal memory, or reflective continuity**. References name exact files/revisions;
attachments are bounded snapshots, not a live shared notebook.

Fresh does not mean instruction-free. Safety constraints and relevant user limits
still travel with the task. A blind reviewer gets the requirements and evidence,
not necessarily the parent's proposed explanation or another reviewer's conclusion.

### Fork

A new session derives from one explicitly selected path through a parent session's
conversation tree. It records source session ID, source entry ID, snapshot digest,
and origin mode. The default anchor is the latest **complete context boundary before
the assistant message that requested the spawn**, not an arbitrary JSONL tail.

- Exclude that in-flight assistant/tool batch wholesale. Its sibling tools may not
  have produced results; never invent successful tool results to close the batch.
- An explicit historical anchor is validated against the selected branch. If it
  splits a tool batch, reject it and offer the preceding safe anchor.
- Copy only the selected ancestry, not abandoned sibling branches or subsequent
  parent turns. Resolve compaction and retained-tail checkpoints correctly.
- Append the delegated assignment once. State plainly: inherited conversation is
  background; this worker owns only this task, not the parent's unfinished work.
- Give it a new session ID, mailbox, run identity, and usage baseline. Do not count
  inherited assistant usage as new worker spend.
- Do not restore parent checklists, queued questions, offer claims, activation grants,
  capability files, run ownership, or mutable workpad bindings from copied entries.
- Forks do not keep following the parent's conversation. Further input is explicit.

**Forked knowledge is not forked authority.** Memory and continuity stay unavailable
to workers. Personality is independently configured, off in the initial worker
profile; none of these toggles is a substitute for a context-sharing decision.

An explicit fork can disclose personal text already present in the conversation,
including earlier tool outputs and compacted summaries, even when memory is now off.
Show this in the launch manifest. Default sharing policy must reject known protected
content or uncertain provenance unless the human has approved that history scope.
Use fresh when it cannot be shared safely. Do not promise to scrub arbitrary personal
information, silently redact a "full" fork, or silently fall back to fresh.

### Snapshot correctness is a prerequisite

Pi's stored entries, `buildSessionContext()`, extension `context` projections, and
provider payload are different layers. Our fixed-boundary workpad/switchboard/memory
snapshots make this especially important. Re-running extension hooks in the child
could query live sources, restore access, or change the historical prefix.

Build a snapshot adapter that freezes the permitted active-path context and records
what was inherited, excluded, or unavailable. Projection must be a pure export of
already selected material, not a new retrieval or activation. Unknown context-changing
extensions must cause a fidelity warning or rejection under the selected policy.

The first spike must establish whether reviewed extension APIs can export this
faithfully. If not, add a narrow **read-only snapshot/export hook in the local Pi
fork** rather than scraping private fields, patching serialized provider payloads,
or calling foreground session-replacement APIs from a tool. Its candidate output is
versioned entries/messages, anchor mapping, and context provenance; no credentials or
live capability objects. Exact API shape is intentionally a spike deliverable.

Parent prefix preservation is mandatory across start, peek, ordinary turns, tool
follow-ups, retries, and unchanged reloads. Child-to-parent cache reuse is a separate
optimization: changed system instructions, tools, cwd, model, or filtered history may
break it. Do not retain dangerous capabilities just to match a cache key. Test actual
provider-bound projection and report measured cache hits separately.

### Logical tree; separate physical session files

```text
Parent session, checkpoint e_42
  ├─ parent continues
  ├─ fork r_1 → child session s_1 → report
  └─ fork r_2 → child session s_2 → report
Fresh r_3 → separate root context, linked to its delegating parent/run
```

Use Pi's tree as the source of ancestry and a combined **investigation-tree view**
as navigation. Each running session file has one writer. Never have several Pi
processes append to the parent's JSONL: their in-memory indexes, leaves, and rewrites
are not a multiwriter session protocol.

Important implementation footguns:

- `ctx.fork()` replaces the foreground session; it does not launch a child.
- `createBranchedSession()` also mutates its owning manager. Never invoke it on the
  live parent's manager; use a detached, frozen snapshot/manager.
- `SessionManager.forkFrom()` copies all non-header entries in the inspected source,
  not just the intended active branch. It is not sufficient by itself.

Append a human-only delegation entry at the origin, with child/run references and a
label where appropriate. `/subagents tree` exposes the linked forest; ordinary
`/tree` can show the origin marker but cannot magically traverse another file.
Native cross-session links in `/tree` are a later, narrow Pi UI enhancement, not a
reason to merge worker transcripts into parent history.

Collecting returns an attributed report, not a splice of the child's conversation.
Later, a human may explicitly open a stopped child's session or clone a promising
child branch to continue it. Inspection itself never moves either agent's leaf.

## 4. Runner and capability architecture

```text
parent Pi extension ── owned run registry ── child process (Pi SDK)
        │                       │                 │
        ├─ launch/join/input    ├─ events/results └─ single child session writer
        └─ human peek UI        └─ private artifacts + immutable launch manifest

switchboard: participant identity, roster, ordinary peer mail
runner: launch authority, process control, budgets, input-needed, results
```

Prefer a small Node child entrypoint using `createAgentSession`, an explicitly
configured `ResourceLoader`, persistent `SessionManager`, SDK events, and a narrow
versioned IPC channel. This combines process separation with SDK-level control.
Do not discover every globally installed extension, custom system prompt, or skill
by default. Preserve reviewed project instructions/trust; load only reviewed worker
resources. Resolve the actual runtime/package version explicitly, not an arbitrary
`pi` executable on PATH.

RPC is a plausible alternative, not a second v1 backend. It already supplies events,
steering and abort, but broad session-control commands and unbounded history reads
still need a runner wrapper. A dedicated SDK worker makes exact grants and structured
reporting easier. A process boundary is not an OS security sandbox.

### Profiles

1. **Inspect (v1):** root-scoped read/search/list tools, bounded artifact reads,
   scoped switchboard correspondence, and a worker-report tool. No shell, `exec`,
   file mutation, nested launcher, memory, continuity, or inherited arbitrary extension.
   Read/search wrappers enforce canonical allowed roots, symlink policy, size/type
   limits, and exclusion of private runner/session/credential directories. Do not
   expose unrestricted built-in `read` and call it privacy isolation.
2. **Implement (next):** explicit mutation grant and isolated worktree, with code
   edits and finite test commands. Shell execution requires its own disclosed trust
   boundary; worktrees do not prevent absolute-path writes or network access.
3. **Stronger OS isolation (later):** container/namespace/VM-backed tool operations
   when actual filesystem/network containment is needed. Never imply profile 1 or
   separate processes defend against malicious same-UID code.

A read-only reviewer cannot run arbitrary tests. It reports inspected tests as
inspected; the parent can execute them, or request a separately authorized validation
run. This is preferable to a "read-only" agent secretly holding Bash.

### Integration with the existing switchboard

Reuse provisioned child participants and real parent/run links. Expose no parent
credential to a worker and do not inherit `PI_SWITCHBOARD_WORKER_FILE` into unrelated
processes. Independent peers still receive only public cards and mail, not transcripts.
An opted-out parent must not publish children via a different default; local runner
inspection can work without switchboard, with correspondence visibly unavailable.

Before using provisioning in a launcher, fix its current lost-response gap:
`provision` creates a server secret but a repeated run ID only returns a conflict.
Add idempotent, parent-scoped provision/recovery and retirement semantics. Persist
launch intent and a private child capability before use; one possible design accepts
a host-generated capability whose hash is bound atomically to parent/run. Never
work around uncertainty by provisioning a second worker.

`extensions/switchboard.ts` currently owns its `BoardRuntime` in a closure. Add a
narrow runner bridge for provisioning and subscriptions instead of registering a
second parent or exposing raw bearer tokens through the event bus/tool output.
Do not make run records special mail messages or reinterpret accepted human offers
as child-launch approval. The dashboard's launch action gets its own explicit target.

## 5. Agent API, lifecycle, and attention

Prefer one stable `subagents` tool and `/subagents` human entrypoint. Illustrative
calls (proposed schema, not available tools):

```json
{"action":"start","mode":"fork","task":"Trace the reload race; cite source.","label":"reload-trace","profile":"inspect"}
{"action":"start","mode":"fresh","task":"Independently review the supplied regression test.","label":"blind-review","profile":"inspect"}
{"action":"peek","id":"r_1","view":"activity","limit":8}
{"action":"join","ids":["r_1","r_2"],"until":"any","seconds":60}
{"action":"input","id":"r_1","requestId":"q_1","text":"Assume reload must cancel owned work."}
{"action":"collect","id":"r_1"}
{"action":"cancel","id":"r_2"}
```

Also provide `list`, `status`, and cursor-paged transcript/artifact views under
`peek`. An optional `from` entry selects a historical fork anchor. Mode is required;
model/thinking inherit the launch-time selection unless explicitly overridden within
the user's grant. An unavailable requested model fails; no hidden provider fallback.

`start` returns after a durable intent and bounded startup handshake, not after the
investigation. It may report `starting` or `start-unknown`; neither means success.
An operation ID permits inspection/exact retry after an uncertain response. Duplicate
operation keys cannot create another process; identical replayed prompts are not a
new launch request. No unbounded launch queue: refuse when capacity is exhausted.

### Keep distinct facts distinct

Store separate process, task/report, and collection state rather than a giant enum:

- Process: starting, live, exited, cleanup-pending, unknown.
- Task: running, needs-input, reported, failed, cancelled, timed-out, budget-exceeded.
- Report: absent, validated envelope, incomplete/unstructured; collection receipts
  separately identify human viewing and parent-model collection.

A process exiting zero or a model becoming idle is not a satisfactory report.
A validated envelope is not a verified conclusion. Cancellation does not undo edits.

Use a small worker-only `subagent_report` tool for progress, needs-input, or final
report. A needs-input request parks inference and retains the process/session within
its deadline; no open model request, mandatory polling loop, or repeated reminder.
An answer addressed to that request resumes the existing run once. Answering is
still covered by the delegated task/budget; broader work needs new authorization.
A final report closes the work phase, but becomes collectable only after tool-batch
settlement and artifact capture. Test Pi's all-tools-terminating semantics rather
than assuming `terminate: true` stops sibling tools.

Settling without the expected report is an incomplete result with inspectable final
text, not permission for three hidden "please format your answer" model calls.
Terminated runs do not reopen on mail or `input`; an explicit follow-on attempt can
later fork an owned child's completed checkpoint with fresh budgets.

### Join and wake policy

`join` is wait-any by default; wait-all still yields early for a blocker, failure,
user input, cancellation, timeout, or runner loss. It returns bounded status and
report IDs, not every transcript. Check already-pending events before subscribing
and fence callbacks by run/session generation. Human input wins over a queued
completion continuation. A child can ask while its parent joins without deadlock.

Default completion handling: update UI immediately and publish a coalesced bounded
hint at the next **existing** parent request. No unsolicited model turn merely
because a child finished. Explicit join provides ordinary tool-result continuation.
A later one-shot "continue when this group finishes" grant can support idle wakeups,
but must be cancelled on stop/session changes; ordinary mail never grants one.

If nothing useful remains, the parent joins rather than repeatedly polling status
or pretending work is done. If the parent deliberately ends its turn, running
children remain visibly owned, but completion does not resurrect that conversation.

### Lifetime policy I would ship first

- Session-owned, finite children; no new always-on inference service.
- Parent turn completion and closing the peek panel do not stop children.
- Explicit cancel stops the selected run. Human global stop must stop all owned
  active children and clear pending continuations; it is not just cancel-join.
- Reload, session replacement, fork/clone replacement, and quit cancel owned work.
  Warn before voluntary changes; defer automatic reload while children are active.
  Integrate this with `/reload-all` and upgrade reloads so an idle parent does not
  silently kill busy children. This must be tested against real Pi abort/lifecycle APIs.
- Parent tree navigation invalidates delivery scope. In v1 require confirmation to
  cancel active children before changing branch; rewinding never repeats launches.
- Child detects parent control-channel loss and stops; deadlines also bound orphan
  work. Crash recovery records unknown/interrupted, never auto-restarts or blindly
  kills a saved PID that could have been reused.
- Graceful abort, then bounded TERM/KILL escalation and exit/cleanup observation.
  A sent signal or Node's `proc.killed` flag is not proof a process tree exited.

Surviving reload or explicit detach is a later supervised-runner feature. I would
rather ship honest session ownership than an accidental background daemon. Durable
records/transcripts survive even when the live process does not.

## 6. Peeking without contaminating the main conversation

Make this part of the first usable slice, not post-launch polish.

### Human surface

Add a Runs tab to the current dashboard and `/subagents` as a focused alias.
Keep switchboard `peers`/`sub` counts as **registered participants**; display running,
blocked, and uncollected run counts separately rather than changing their meaning.

```text
Subagents — 2 running, 1 needs input
reload-trace   fork e_42   read lib/runtime.ts   2m14s   7 tools
blind-review   fresh      reporting findings    1m48s   5 tools
schema-check   fork e_31  needs input           0m52s

[Enter] peek  [t] lineage  [m] message/input  [x] cancel  [Esc] back
```

Peek has Activity / Transcript / Artifacts / Origin tabs. Show current tool(s),
recent tool completions, public assistant text, errors, timestamp/age, model/thinking,
usage, context occupancy, and explicit progress declarations. Rendering derives from
SDK events; no inferred "80% done" or model-assisted narration.

Default to the child's new work, not the inherited prefix. The origin view exposes
exact snapshot provenance and sharing/capability decisions. Transcript expansion is
bounded, searchable, and cursor-paged; scrolling back disables follow-tail without
stopping updates. Preserve selection, scroll, and editor draft across refresh/resize.
Partial streamed arguments are not completed tool calls. Sanitize terminal controls.

Opening or refreshing a pane makes no provider call, sends no input, acknowledges
no mail/result, attaches no writer, and does not publish viewed content to the parent
model. Do not expose private reasoning through the default activity surface.

A future "take over" button is a separate confirmed control transfer: stop/fence the
worker writer first, then open its saved session. Never attach a second live writer
just to make inspection easy. Native worker `/tree` navigation must also remain
separate from peeking.

### Model surface

`peek(activity)` returns a small factual card; transcript/artifact reads are explicit
and bounded. Child output stays attributed external data. No periodic raw trace dumps
into the parent prompt, no continuous recency shuffling, and no automatically shared
sibling transcripts. Public roster labels must not leak private assignment bodies.

Initial proposed bounds: activity 8 events / 4 KiB; transcript page 16 KiB;
collection envelope 8 KiB plus artifact references. Include omitted counts, cursors,
and unavailable/pruned markers. Human viewing and model collection use separate
receipts. Repeated collect returns the same immutable report, not another completion
wake or another charge for inherited work.

## 7. Results, repository work, and budgets

A compact report should contain:

- Outcome: completed / partial / blocked / inconclusive.
- Answer/findings with source path, line/revision references and key uncertainties.
- What was inspected versus what was actually executed.
- Execution receipt references where available; otherwise explicit unverified claims.
- Changed files and artifact references; source baseline, end snapshot, and caveats.

Host-observed facts sit alongside, not inside the worker's claimed verdict:
termination reason, tools executed, usage, artifact hashes, and collection receipts.
The parent verifies consequential claims. No automatic promotion into evidence or
memory and no automatic completion of its checklist from a child's report.

### Editing workers: next vertical slice

Keep context origin independent of filesystem mode: both fresh and forked workers
can eventually use worktrees. Pin HEAD and a source manifest. A clean worktree at
HEAD does not include the parent's uncommitted changes; either require a clean
baseline or explicitly capture a bounded, reviewed dirty-tree overlay. Never stash
or commit the user's checkout behind their back.

Capture resulting changes as inspectable patches/artifacts, including untracked and
binary handling. Detect submodule/nested-repository changes; initially refuse unsupported
cases rather than omit them. A conversation fork alone is never filesystem isolation.

Return changes for review. Do not automatically apply OMP-style combined patches,
merge, cherry-pick, stage, commit, or resolve conflicts. Integration rechecks the
current target baseline and exact diff; unexplained shared-checkout changes block it.
Failed/cancelled worktrees are retained visibly until explicit cleanup, with disk
quotas. Worktree/patch completeness tests precede any optional integration barrier.

### Initial limits to validate

| Resource | Proposed default / rule |
|---|---|
| Active workers | Main agent chooses 0..ceiling; ceiling is user-configured, not a prescribed team size |
| Descendants | None; host and switchboard both reject child provisioning |
| Worker lifetime | 10 minutes; includes needs-input time; explicit maximum 30 minutes |
| Model work | 24 responses, 80 tool calls, bounded response output; configurable downward |
| Fresh task + attachments | 32 KiB total; explicit per-attachment bounds |
| Fork context | Preflight against child context window with output reserve; no silent truncation/compaction |
| Retries/compaction | Explicit budgeted policy; retries count; v1 may stop for oversized context rather than make hidden summary calls |
| Storage | Per-run and per-session quotas; cap live event buffers independently of saved history |

Set exact storage/output-token limits during the first runner slice. Dollar/token
accounting must include worker retries, any authorized compaction, and nested usage
without double-counting inherited history or repeated collection. Enforce request/tool
counts before execution. Provider-reported token/cost limits can overshoot by an
in-flight response and missing pricing means unknown, not free or a hard spend cap.
No silent fallback, GPU model loading, or eviction; local inference capacity is a
separate configured limit and must preserve 4090 headroom.

## 8. Implementation sequence and acceptance gates

### A. Fork/context spike — first, no live model

Create synthetic branched sessions with parallel tools, old/new compactions, labels,
fixed-boundary projections, protected context, and copied activation entries. Verify
safe extraction, snapshot/provenance behavior, and unchanged parent state. Compare
the installed SDK with the local Pi fork. Decide whether the narrow core snapshot
hook is necessary and document exactly which contexts can be faithfully forked.

**Exit:** both fresh and fork semantics are demonstrable; no malformed tool pairs,
sibling leakage, inherited access, live-source rereads, or invented cache guarantee.
This spike should be small enough to reject an unsafe shortcut before building UI.

### B. One owned worker, both origins, minimal peek

Add `extensions/subagents.ts`, `lib/subagents/{types,policy,snapshot,store,runtime}.ts`,
a dedicated `tools/subagent-worker.ts`, and fake-worker/SDK fixtures. Fix switchboard
provision/recovery/retirement and add the private adapter bridge. Implement persistent
launch intent, the SDK child handshake, inspect profile, event journal, deadlines,
structured report, status/peek/collect/cancel, and one small viewer.

**Exit:** launch returns promptly; fake child events are visible while parent work
continues; every accepted run has an inspectable outcome, even when startup fails.
No external model calls in tests; the two origins ship together.

### C. Agent-chosen parallelism and useful human controls

Add concurrency admission, join-any/all, needs-input/answer, scoped sibling mail,
Runs/Origin/Transcript views, linked investigation tree, and coalesced parent hints.
Exercise parent stop, pending user input, branch changes, reload-all, service loss,
disk failure, duplicate operations, partial IPC frames, noisy output, process exit
without a report, and stale callbacks.

**Exit:** exercise zero, one, two, four, and at-ceiling workers, plus refused
above-ceiling launches. The parent can add workers while others run. A parent joining
two children can answer one, inspect the other, cancel, and collect without deadlock
or duplicate work. Two is a useful test case, not a scheduling policy. Peek is
model-free and side-effect-free. Ordinary mail never wakes an idle model; stale or
replayed completions do not either.

### D. Read-only MVP acceptance

Run full package tests/typecheck plus network-disabled real Pi SDK/provider-payload
fixtures. Test capability escapes through absolute paths, symlinks, dynamic tools,
unauthorized resources, and copied memory/continuity grants. Verify parent and child
provider projections across ordinary turns, tool follow-ups, retry, reload, tree,
and compaction; distinguish lifecycle changes that intentionally break the prefix.

Then, only with separate approval, do a small live trial: one forked investigation
and one fresh review of the same concrete issue. Evaluate useful findings, parent
context saved, latency/cost, missed constraints, duplicated investigation, and how
easily the human can tell whether a worker is blocked. Live spend is not authorized
by passing fixture tests. Do not claim physical-terminal ergonomics from unit tests.

### E. Worktree implementation workers

Add baseline capture, mutation profile, finite test execution, exact change artifacts,
conflict detection, and explicit cleanup. Use temporary repositories with dirty,
untracked, binary, nested-repo, and concurrent-change fixtures.

**Exit:** the parent checkout remains untouched by default; results are reviewable
and source-attributable. Automatic integration/commits remain a separate feature.

### Later, only if useful

- Native cross-session links in Pi's `/tree`; explicit stopped-child takeover.
- Forking a completed owned child for a follow-up, or comparing approaches from one
  common checkpoint. Reusing context is not silently reusing old run authority.
- Supervised reload survival/detach and one-shot continuation barriers.
- Strong OS isolation and separately approved repository integration.

Do not block the read-only MVP on these. The key deliverable is **a genuine choice
between inherited understanding and a clean second opinion, with a window into the
work and an unambiguous way to stop it**.
