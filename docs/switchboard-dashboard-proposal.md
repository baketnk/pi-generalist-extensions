# Proposal: switchboard dashboard, coordinator, and dispatcher

Status: **dashboard + interactive human task offers implemented**; remaining slices
are design only. See the [implemented contract](switchboard-dashboard.md) for exact
controls, authority, lifecycle, limits, and validation. The chosen first orchestration
workflow is interactive offers, not managed workers or automatic session replacement.

This document records the broader follow-on to the
implemented [Pi switchboard MVP](switchboard.md) and the broader
[agent-coordination design](agent-coordination-proposal.md). It does not authorize
agent launches, automatic session replacement, provider calls, repository mutation,
or commits.

## Direction

Add an orchestration surface above the switchboard without making presence or mail
pretend to be a task runner:

1. A **dashboard** presents registered participants, assignments, managed runs,
   results, and attention items to the human without inference.
2. An optional **coordinator model**, configured separately from working agents,
   interprets natural-language requests and proposes routing or orchestration plans.
3. A deterministic **dispatcher/runner** validates authority and eligibility,
   claims assignments atomically, controls worker processes/sessions, and records
   run/result facts.
4. The existing **switchboard service** continues to own identity, presence,
   correspondence, subscriptions, and narrowly scoped delivery queues.

This supports requests such as:

```text
Which agents are working, blocked, or available?
Find an appropriate idle worker to review the storage changes.
Queue this task for a session that accepts automatic new-session assignments.
After every task in this group has a collected result, inspect the repository,
run the agreed checks, and create one coherent commit if attribution is clear.
```

The coordinator may understand these requests. It must not be the component that
silently grants itself permission, treats `idle` as completion, or decides that a
dirty shared checkout is safe to commit.

## Non-goals

- Turning ordinary switchboard notes, questions, or handoffs into executable jobs.
- Treating the registered roster as a process census or resource scheduler.
- Reassigning every interactive session merely because its model is not streaming.
- Running a hidden model from the switchboard daemon or giving the daemon provider
  credentials.
- Replacing the foreground session's model, prompt, tool set, or context with the
  coordinator's configuration.
- Inferring task completion from an assistant message, an idle transition, lease
  expiry, process exit, or a peer's claim alone.
- Automatically staging all changes in a shared checkout or attributing a diff to
  whichever participant happened to settle last.
- A recurring autonomous planner, global cron scheduler, remote control API, or
  self-expanding swarm.

## Experience

### Dashboard

An extension command such as `/switchboard dashboard` can open a live TUI overlay:

```text
Switchboard desk — registered participants; partial local view
──────────────────────────────────────────────────────────────────────
Participant                  Activity          Availability   Work
bridge-camp-mouse-pearl      working           manual         continuity
acorn-crown-jay-glow         idle for 12m      queue          review tests
worker · storage-tests       result available  managed        run r_42

Assignments
q_17  integrate repository   waiting for group g_8
q_18  review storage changes proposed → acorn-crown-jay-glow

Attention
• worker r_41 needs input
• switchboard coverage unavailable for one checkout

[enter] inspect  [d] dispatch  [a] ask coordinator  [m] message
```

The exact keybindings and layout remain provisional. Essential behavior:

- Long-poll or subscription updates refresh the view without making model calls.
- Coverage is labelled registered/partial/stale/unavailable rather than exhaustive.
- Activity, assignment state, process state, and result state remain separate.
- The human can inspect source timestamps and provenance for derived summaries.
- Model use is explicit in the UI, cancellable, and accompanied by usage/failure
  information.

Pi extensions can provide this as a custom overlay. If a persistent standalone
`pi switchboard` experience becomes desirable, build it as a small Pi SDK/TUI
application rather than claiming an extension can register a new core run mode.

### Coordinator conversation

The dashboard may offer a small natural-language input:

```text
Human: Find someone who can review the changed switchboard storage code.

Coordinator proposal:
1. acorn-crown-jay-glow — idle 12m, accepts queued work, review capability,
   separate worktree.
2. worker storage-tests — result not yet collected; currently ineligible.

Proposed action: queue q_18 for acorn-crown-jay-glow, requiring human acceptance.
```

The proposal must preserve the original human text. Model-written decompositions,
summaries, capability matches, or urgency are derived data, not substituted user
authority.

## Architecture

```text
┌──────────────────────────────┐
│ Dashboard / human controls   │
│ roster · queue · runs · chat │
└──────────────┬───────────────┘
               │ optional bounded request
┌──────────────▼───────────────┐
│ Coordinator model session    │
│ interpret · rank · propose   │
└──────────────┬───────────────┘
               │ typed proposals only
┌──────────────▼───────────────┐
│ Dispatcher / runner          │
│ validate · claim · launch    │
│ wait · cancel · collect      │
└──────────────┬───────────────┘
               │ scoped service operations
┌──────────────▼───────────────┐
│ Switchboard service          │
│ presence · mail · queues     │
└────────┬──────────────┬──────┘
         │              │
 live interactive Pi   managed worker Pi
 adapter               process / SDK runtime
```

### Dashboard owns

- Human interaction, rendering, filtering, inspection, confirmation, and explicit
  coordinator invocation.
- A model-free view that remains useful when no model is configured or available.
- Display of assignment/run provenance, generation, age, uncertainty, and policy.

### Coordinator owns

- Parsing a written request into a proposed task description, constraints,
  capabilities, dependency/barrier shape, and candidate ranking.
- Explaining why candidates were included or rejected based on supplied facts.
- Asking for clarification when the request cannot be represented safely.

It does not own participant credentials, process handles, acceptance decisions,
Git locks, or final state transitions.

### Dispatcher/runner owns

- Eligibility filtering, atomic assignment claims, deduplication, expiry, and
  cancellation.
- Worker provisioning and launch configuration: cwd/worktree, model, thinking,
  tools, context, timeout, concurrency, and cost limits.
- Live-session delivery policy and the decision whether delivery is allowed now.
- Process/run lifecycle, bounded output, input-needed signals, result collection,
  and terminal outcome records.
- Dependency groups and one-shot integration barriers.

### Switchboard owns

- Existing participant identity, attachment fencing, presence, roster visibility,
  mailboxes, and subscriptions.
- Narrow private control-queue transport for opted-in live adapters.
- Authentication and visibility checks for dispatcher operations.

The switchboard must not infer that accepting a message starts a run. Assignment
and run records may share its local service/storage, but they require their own
protocol objects and authorization rather than special mail kinds.

## Coordinator model contract

The coordinator should use a separate Pi SDK or RPC session. Calling `pi.setModel()`
on the foreground session is wrong because it changes that session's model and
records the change in its history.

Suggested explicit configuration:

```json
{
  "enabled": false,
  "model": "provider/small-model",
  "thinkingLevel": "off",
  "maxInputBytes": 32768,
  "maxOutputTokens": 2048,
  "timeoutSeconds": 30,
  "maxCostPerRequest": 0.02,
  "tools": [
    "coordination_snapshot",
    "inspect_candidate",
    "propose_assignment"
  ]
}
```

Defaults and exact limits remain undecided, but the following are requirements:

- Disabled unless the human configures and invokes it; no startup inference.
- No fallback to the active working model or another provider when unavailable.
- No general shell or file-mutation tools. Read-only repository inspection, if
  later added, is a separate disclosed grant with bounded outputs.
- A dedicated system prompt and fresh/bounded task context, not a copy of every
  working transcript, personal memory, workpad, or reflective source.
- Explicit timeout/cancellation and usage accounting visible to the human.
- No silent local GPU load/eviction. A local endpoint must respect separately
  configured capacity and VRAM headroom.
- Coordinator output is labelled derived, timestamped, and tied to the exact
  roster/queue generation it saw.

The first coordinator slice should be read-only: it can answer status questions
and emit a typed proposal. Dispatch becomes a separate confirmed action. Later,
an explicitly enabled automatic policy may allow bounded dispatch to managed
workers without confirmation; interactive sessions should remain more conservative.

## Participant availability and scheduling facts

The current switchboard activity states are useful for display but insufficient
for scheduling. `updatedAt` reflects heartbeats, not time spent idle. Add explicit,
source-labelled fields or related records such as:

```text
availabilityPolicy     manual | queue | auto-followup | auto-new-session | worker
capabilities           bounded declared identifiers
idleSince              adapter-observed agent-settled transition
assignmentCount        dispatcher-observed accepted assignments
queueDepth             dispatcher-observed pending assignments
currentAssignmentId    if any
currentRunId           runner-owned managed attempt, if any
checkoutMode           shared | worktree | read-only
acceptsMutation        explicit policy, not inferred from tools alone
generation             changes on policy/capacity/assignment transition
```

Capabilities and summaries may be user-, runner-, or agent-declared. Their source
must remain visible; a model-generated capability guess is not equivalent to a
runner-enforced tool grant.

### Candidate selection

Selection should proceed in layers:

1. **Deterministic scope:** project/worktree visibility and requested target.
2. **Authority and policy:** recipient accepts this delivery/session mode.
3. **Hard capability checks:** required tools, mutation policy, platform, checkout,
   budget, and runner availability.
4. **Capacity checks:** online lease for live dispatch or launch capacity for a
   managed worker; queue/concurrency limits.
5. **Optional semantic ranking:** coordinator compares the written task to declared
   names, summaries, and capabilities.
6. **Atomic claim:** dispatcher commits the assignment against the candidate's
   expected generation. A stale proposal fails and must be refreshed or reviewed.

“Most idle” should be a transparent scoring policy, not a magical model verdict.
For example, eligible idle duration and queue depth can be deterministic, while
task-fit ranking may be derived. Stable tie-breaking avoids oscillation. No task
should be dispatched merely because every better candidate was temporarily absent
from a partial roster.

## Assignment and run lifecycle

Keep assignment, delivery, execution, and result facts distinct.

Suggested assignment states:

```text
proposed
queued
offered
accepted | declined | expired | cancelled
delivered
```

Suggested managed-run states:

```text
provisioning
starting
running
needs-input
exited
result-available
result-collected
failed | timed-out | cancelled | unknown
```

An assignment can be accepted but fail to start. A process can exit without a
valid result. A worker can claim success without the runner collecting the expected
artifact. A result can be collected without human acceptance. Preserve all these
distinctions.

Every assignment/run attempt needs stable IDs, service timestamps, creator and
authority provenance, project/worktree identity, original task, derived task if
any, dispatch policy, model/tools/budgets, and idempotency keys. Lost responses
must be resolved by querying/retrying the same operation, never by blindly creating
a second attempt.

## Delivery into a live Pi process

The implemented reload queue demonstrates a useful transport pattern: a receiving
adapter notices a private queued control item, claims it, and enqueues an internal
extension command as a follow-up. Assignment delivery can use the same mechanism
without exposing bearer capabilities or relying on a peer mail body.

### Same-session follow-up

For `auto-followup`, after the current agent fully settles, the adapter can enqueue
an internal command that validates the claimed assignment and then delivers the
original user-authorized task. This continues the existing conversation and must
be allowed only by explicit policy because old context can influence the new task.

### New session in the same process

For `auto-new-session`, the internal command can use Pi's command-only session
replacement API:

```ts
await ctx.newSession({
  parentSession,
  setup: async (sessionManager) => {
    // Append non-secret assignment provenance before the first run.
  },
  withSession: async (newContext) => {
    await newContext.sendUserMessage(originalTask);
  },
});
```

The event/watch callback itself cannot call `newSession`; it must cross into a
command context. After replacement, only the fresh `withSession` context is valid.
The adapter must recheck policy, assignment generation, project identity, and
session id before replacement and again before sending the task.

This mechanism commandeers the live TUI's active conversation. Therefore:

- Interactive sessions default to `manual` or `queue`, not automatic replacement.
- The dashboard visibly warns when a policy permits automatic replacement.
- Active user prompts, pending extension questions, session-switch guards, or
  dirty-repository guards may defer or reject delivery.
- Decline/cancel remains a first-class outcome; a rejected replacement is not
  retried forever.
- The task message preserves its dashboard/user provenance. Derived coordinator
  text cannot masquerade as a fresh human message.

### Offline sessions

A queued control item does not wake an absent process. Sending mail or an assignment
to an offline participant must not launch it. Durable restart and worker launch
belong to the runner, which provisions a fresh attempt and starts a process or SDK
runtime under an explicit policy.

## Managed workers and non-blocking coordination

Prefer a separate process or SDK runtime for managed workers. The runner should
offer `start`, `status`, bounded `output`, `cancel`, `collect`, and interruptible
`wait`/`join` operations. It should integrate with switchboard provisioning so a
worker appears as a related participant with its own capability rather than
inheriting its parent's credentials.

Do not make the only coordinating agent wait synchronously inside a worker tool
for the entire run. Use:

```text
start → continue other useful work → collect
```

An interruptible join may return because of completion, user input, addressed
question, output-check deadline, timeout, cancellation, or service loss. A worker
question leaves the worker running and returns control to an agent or human who
can answer. No model-driven polling loop is required.

## Dependency groups and repository integration

Requests such as “have the last agent sort through the repo and commit it” should
be represented as a dependency group and an integration assignment, not an idle
hook:

```text
group g_8 requires collected results from r_40, r_41, r_42
when the barrier is satisfied once:
  queue integration assignment q_17
```

The barrier is based on explicit required run outcomes and collected results. It
does not fire merely because all visible participants look idle or disappear.
Terminal failures produce a policy-defined blocked/partial state rather than being
silently ignored. Barrier firing must be idempotent.

### Integration-agent contract

An integration agent that may commit must be separately authorized and required to:

- Inspect `git status`, the exact diff, staged state, untracked files, nested
  repositories/submodules, branch/HEAD, and relevant worker commits/results.
- Reconcile claimed ownership with current source; participant presence or a
  completion sentence does not attribute a file.
- Refuse to stage unexplained or unrelated changes and report the ambiguity.
- Prefer isolated worker worktrees and explicit commits/cherry-picks over concurrent
  mutation of one shared checkout.
- Recheck the expected repository generation immediately before staging/commit;
  serialize integration operations for that checkout.
- Run the agreed validation and retain execution receipts where available.
- Create only a coherent, scoped commit with an inspectable message and resulting
  commit ID. Never default to `git add -A` across unknown work.

The “last finishing agent” should normally mean a dedicated integration run started
after the barrier, not whichever worker happened to settle last. A shared checkout
cannot be frozen merely by switchboard convention; robust workflows should use
worktrees or an explicit cooperative mutation/integration lease, while honestly
acknowledging that unrestricted same-UID processes are not sandboxed.

## Authority, security, and privacy

- Only an explicit human request or previously configured dispatch rule can create
  executable assignment authority. Peer mail and coordinator prose cannot expand it.
- Separate observer, coordinator, dispatcher, runner, participant, and administrator
  capabilities. The coordinator should generally receive no credential that can
  mutate service state.
- Keep provider credentials out of the daemon, assignment records, worker capability
  files, prompts, tool results, and logs.
- A same-UID local agent with unrestricted shell remains able to inspect or tamper
  with local state; scoped APIs prevent accidental misuse, not malicious code.
- Task text, participant declarations, repository content, worker output, and
  coordinator output are untrusted data. Bound and frame them at every model
  boundary.
- Do not copy full transcripts, workpads, memory profiles, reflective sources, or
  arbitrary environment variables into coordinator/worker context.
- Record model/provider disclosure and usage for coordinator calls. Disabling the
  feature stops future calls but cannot erase text already sent to a provider or
  retained in session history.
- Project-local dispatch configuration is honored only under Pi's project-trust
  policy. User-global safety policy wins over repository requests.

## Failure semantics

- **Switchboard unavailable:** dashboard shows unknown coverage; no candidate is
  inferred to be available and no dispatch falls back to process scanning.
- **Stale proposal:** atomic claim rejects; coordinator output remains historical.
- **Lost dispatch response:** query/retry the same operation key; never compose an
  equivalent second assignment automatically.
- **Recipient goes busy:** offer may remain queued or fail according to policy; do
  not steer an unrelated active run unless explicitly configured.
- **Recipient disconnects:** a live-session assignment waits/expires; it does not
  become permission to spawn a replacement worker.
- **Session replacement cancelled:** record declined/deferred/cancelled accurately.
- **Runner crash:** surviving process state becomes recoverable or `unknown` under
  the runner's declared lifetime; never guessed into success.
- **Coordinator failure or timeout:** retain deterministic dashboard/dispatch UI;
  no fallback model and no partial proposal execution.
- **Barrier ambiguity:** remain blocked and visible. Do not choose “close enough”
  terminal states or fire twice.
- **Repository changed during integration:** abort/reinspect rather than committing
  against stale review.

## Implementation slices

### Slice 1: model-free dashboard

- Live roster/inbox viewer over existing subscription state.
- Clear activity, relationship, checkout, age, and coverage presentation.
- No new daemon inference, assignment semantics, or process control.
- TUI overlay first; standalone SDK shell only if persistent mode ergonomics demand it.

### Slice 2: read-only coordinator

- Explicit configuration and invocation of a separate small model session.
- Synthetic roster/task inputs and typed `propose_assignment` output.
- No dispatch tool, shell, repository mutation, or hidden fallback.
- Usage, timeout, cancellation, source generation, and raw/derived distinction shown.

### Slice 3: interactive assignment offers

- Assignment records, atomic claims, expiry, accept/decline/cancel, and policy UI.
- `manual` and `queue` policies first.
- Fixture delivery into live Pi sessions without model network calls.
- Automatic follow-up/new-session policies remain explicit opt-ins with lifecycle
  and dirty-repository guard tests.

### Slice 4: managed worker runner

- Parent-scoped provisioning, separate worker processes or SDK runtimes, bounded
  model/tools/context, start/status/output/cancel/collect, and durable run attempts.
- Non-blocking start/continue/collect plus interruptible join.
- Clear process exit, result availability, result collection, and agent claim facts.

### Slice 5: barriers and integration

- Durable dependency groups with one-shot, idempotent barrier firing.
- Worktree-first integration flow and explicit mutation/commit authority.
- Exact diff/source-generation checks and execution-receipt links.
- Shared-checkout ambiguity and concurrent mutation fail closed.

## Acceptance matrix

### Dashboard and coordinator

- Zero configured model still yields a useful live dashboard.
- Opening, refreshing, filtering, and closing the dashboard makes no provider call.
- Partial/stale/unavailable registration never appears as an exhaustive idle pool.
- Coordinator calls use only the configured model and bounded supplied facts; timeout,
  auth failure, cancellation, and budget rejection are visible.
- Foreground model/thinking/tools/session history and provider cache prefix remain
  unchanged across coordinator use.
- Hostile participant summaries/task text cannot invoke tools outside the typed
  coordinator contract or become user authority.

### Selection and dispatch

- Hard eligibility is deterministic and explainable; semantic ranking cannot
  override policy/tool/platform/checkout constraints.
- Simultaneous claims against one candidate produce at most one accepted assignment.
- Idle duration uses `idleSince`, not heartbeat time; idle never equals completion.
- Busy, waiting-for-user, opted-out, offline, stale, and unavailable candidates
  follow documented policy.
- Manual/queue sessions are never automatically replaced. Auto policies are explicit,
  persisted outside branch rewind, and revalidated at delivery.
- Reload/resume/fork/new/tree and extension reload do not duplicate assignment
  acceptance or task delivery.

### Runner and results

- Launch failure, running, needs-input, exit, timeout, cancellation, unknown process
  state, result available, and result collected remain distinguishable.
- Worker questions can return attention without killing the worker or blocking the
  only agent able to answer.
- Capability files are private and scoped; children cannot recursively provision or
  impersonate their parent.
- Aborted or crashed attempts do not silently restart, and lost responses reuse the
  original operation identity.

### Repository integration

- A barrier fires once only after its exact required outcomes/result conditions.
- A failed or missing worker yields a visible blocked/partial group according to
  configured policy, not an invented success.
- Integration detects unexplained dirty files, staged changes, submodule/nested-repo
  state, branch changes, and source mutation after review.
- No broad staging or commit occurs when attribution/scope is ambiguous.
- Successful integration reports reviewed inputs, validation receipts, exact commit,
  and any remaining dirty state separately.

Use synthetic participants, temporary repositories/worktrees, scripted model streams,
and network-disabled SDK fixtures first. Report real multi-session TUI checks, live
provider evaluation, process-runner acceptance, and commit-workflow trials separately.

## Open decisions

- Extension overlay only, standalone SDK dashboard, or both?
- Where should coordinator settings live, and should model selection reuse the
  generalist model picker without changing its foreground-session semantics?
- Are interactive `auto-followup` and `auto-new-session` worth supporting, or should
  all automatic dispatch be limited to runner-managed workers?
- Which capability declarations are enforced facts versus advisory labels?
- Should assignments/runs live in the existing SQLite service under separately
  scoped APIs or in a runner-owned store linked by IDs?
- What process lifetime and recovery guarantee should managed workers have across
  Pi reload, dashboard exit, runner crash, logout, and reboot?
- What checkout lease or worktree policy is sufficient before enabling automatic
  integration commits?
- Which terminal worker outcomes satisfy a barrier, and who can approve a partial
  barrier after failures?
- How much repository context may the coordinator inspect before it stops being a
  lightweight routing assistant and becomes another coding agent?

Implementation decision: model-free dashboard plus interactive human-approved offers,
with manual/queue/off recipient policy and separately confirmed same-session Start.
Coordinator, automatic session replacement, managed runner, barriers and integration
remain future slices. A future managed runner should begin with human-confirmed launches,
explicit model/tool/time/concurrency budgets and separate worktrees for mutation; no
automatic commits or interactive-session replacement. See the implemented contract
rather than treating speculative controls above as available.
