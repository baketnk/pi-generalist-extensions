# Tooling roadmap

This document outlines gaps identified while considering ordinary coding work and larger, interactive projects such as Kouseki. It is a proposal, not an approved implementation plan or a promise to reproduce another harness's feature set.

The goal is a balanced set of explicit, portable capabilities: tools that reduce real friction while keeping authority, process ownership, and evidence clear.

For ideas worth retaining but **not queued for implementation**, see [parked ideas](PARKED-IDEAS.md). That document is a discussion shelf, not an additional backlog or implementation authorization.

## Current baseline

The environment already provides file reads and edits, shell execution, and parallel tool calls. This package adds several complementary capabilities:

- **History search/read:** bounded, cited access to earlier conversations.
- **Workpad:** in-session revisable task understanding, separate from a checklist or out-of-session durable memory.
- **Evidence shelf:** immutable source excerpts with explicit freshness checks.
- **Tasks and questions:** progress tracking, blocking clarification, and asynchronous user input.
- **Optional personality and native selective memory:** independently enabled continuity aids with local indexed recall and explicit capture.
- **Managed background jobs and execution receipts:** session-bound Linux jobs with bounded output and immutable execution records.
- **Optional `apply_patch`:** preflighted Codex-style local patch application, separate from built-in edit.
- **Switchboard dashboard and human task offers:** model-free roster/mail inspection and explicitly accepted foreground task delivery.
- **Host-provided Code Mode (local Pi fork):** opt-in trusted nested-tool composition through a disposable Node worker; it is not packaged here or sandboxed.

These provide useful remembering, execution, and organizing primitives. Native memory no longer depends on foreground wake/nap compression: ordinary retrieval is local and the optional housekeeping reviewer is separately configured and human-triggered. The remaining gaps center on making nested-tool orchestration portable and safely supportable, delegation, external information retrieval, visual observation, and the proposed orchestration follow-ons.

A missing first-class interface does not imply that the underlying capability is impossible. Shell commands, local programs, and project-specific scripts can often substitute. The question is where repeated improvisation creates enough lifecycle, safety, or context-management cost to justify a dedicated interface.

## Suggested priorities

| Capability | Suggested priority | Main benefit |
| --- | --- | --- |
| Managed background jobs | Implemented Linux-first MVP | Reliable finite local work without ad hoc process management |
| Trusted Code Mode / nested-tool orchestration | Local Pi-fork MVP; portability and A/B evaluation pending | Fewer model round-trips through bounded nested-tool composition |
| Pi-native selective memory | Foreground MVP; live review pending | Relevant continuity without foreground compression; portable originals |
| Bounded subagents | Inspect runner implemented; live fresh Codex trial passed; fork deployment gated on core hook | Isolated investigations and independent reviews |
| Switchboard dashboard and dispatcher | Dashboard, interactive offers and inspect runner implemented; broader coordination proposed | Human-approved routing and bounded investigations; integration remains future work |
| Web search and readable retrieval | Next candidate | Research without repeatedly building fetching and extraction plumbing |
| Visual inspection loop | Project-driven | Observe and validate interactive applications |
| Execution receipts | Implemented for new managed jobs | Preserve what actually ran and under which source state |

Managed jobs and their initial receipts are implemented as independent execution capabilities. Pi-native memory is an independent, explicitly activated design track; its optional housekeeping reviewer can use a separately selected Pi model. Further implementation ordering should follow demonstrated needs and separate approval.

## 1. Managed background jobs

Implemented Linux-first, session-bound MVP: [focused bg-tasks proposal](bg-tasks-proposal.md), including its declared lifetime, cancellation, output cursors, and notifications. Persistent jobs, services, scheduling, remote execution, and broader platform support remain proposed only.

### Problem

A blocking shell tool works well for short commands. Builds, test suites, servers, renderers, and experiments need a longer-lived execution model. Using shell backgrounding and log files puts process tracking, polling, cancellation, and recovery into conversational reasoning and one-off scripts.

For example, a Kouseki build could run while the assistant reads a separate subsystem. It should not require holding a shell call open, repeatedly reconstructing a PID, or guessing whether a process survived interruption.

### Desired contract

A job interface should support:

- Starting a command with an explicit working directory and returning a stable job ID.
- Inspecting state, start/end times, exit status or termination signal, and bounded incremental output.
- Reading logs with cursors so polling does not repeatedly inject the same text.
- Cancelling owned work, with a defined graceful-termination period and bounded escalation.
- Reporting completion without continuous model-driven polling.
- Listing jobs owned by the current session/project and distinguishing active work from historical records.
- Explicitly handling session interruption, reload, and shutdown.

Possible operations are `start`, `status`, `output`, `cancel`, and `list`; names and schemas remain undecided.

### Ownership and safety

- Identify owned processes robustly; a remembered numeric PID is not sufficient protection against PID reuse.
- Define whether process groups, descendants, or stronger containment are available on each platform. Do not promise universal process-tree termination without testing detached children.
- Never infer ownership from a broad executable-name match.
- Distinguish finite jobs from persistent services. Starting a server must not silently grant indefinite lifetime.
- Do not adopt, terminate, or restart user applications or unrelated sessions automatically.
- Define concurrency limits, timeouts, output quotas, and disk-retention limits.
- Treat logs as potentially sensitive and untrusted. Do not automatically copy complete environments or credentials into metadata.
- Completion notifications must be deduplicated and must not implicitly authorize more work.

### Small first version

Start with local finite commands, durable metadata and logs, bounded output reads, status, and explicit cancellation. Keep scheduling, remote execution, and service orchestration out of scope.

Decide whether jobs survive harness exit before implementing persistence. A stale record must become `unknown` or another explicit recovery state, not be guessed into success or failure.

### Acceptance criteria

- Long-running work returns control promptly and can be inspected while unrelated tools run.
- Success, nonzero exit, signal termination, timeout, and launch failure remain distinguishable.
- Cancellation tests include cooperative children, stubborn children, and unrelated processes that must remain untouched.
- Reload/recovery tests verify the declared lifetime policy.
- Large output remains bounded in context and on disk; cursors do not silently lose or duplicate output.
- Completion is reported once, with no automatic restart or follow-on execution.

## 1a. Trusted Code Mode / nested-tool orchestration

Detailed comparison and evaluation notes: [Astra harness efficiency and Codex-style `exec`](harness-efficiency-and-exec.md).

**Implemented locally in the Pi nested-tools fork, not in this package or stock Pi.** The active local launcher loads an opt-in `exec` extension backed by Pi-core `ctx.tools.invoke` dispatch. Each call runs JavaScript in a fresh disposable Node worker and can compose explicitly allowed active tools through the normal schema, hook, activation, mutation-queue, cancellation, result, and event pipeline. It supports bounded loops, branching, and up to four concurrent child calls; nested traces are persisted as custom entries and the provider receives only selected output plus automatic failure/unfinished-call summaries. Current bounds include 32 child calls, 64 KiB source, 50 KiB printed output, 4 MiB aggregate nested results, and a 60-second default deadline (up to 300 seconds).

This is deliberately **trusted local execution, not a security sandbox**. The worker uses a reduced environment and process boundary, but it retains ordinary Node/file/network/process capabilities; direct host I/O bypasses brokered validation and tracing. Only the configured allowlist is brokered. Stateful extensions require individual compatibility review before nested use; blocking questions, session changes, and background-job orchestration remain direct. Linux Node/tsx is the supported development path; standalone Bun binaries and Windows process-tree teardown are not validated.

The fork's extension and core dispatcher have tests for nested validation/traces, cancellation, child-result handling, and stable provider-context projection across ordinary turns, retries, and unchanged reloads. The local [session metrics](session-metrics.md) utility reports persisted outer/nested trace counts. Neither is a live cache-hit measurement or proof of saved model turns. A controlled Astra A/B trial, portable upstream API/package integration, an actual restricted runtime, and compatibility review for more extensions remain future work.

## 2. Bounded subagents

Implemented slice: [owned inspect subagents](subagents.md), with agent-chosen
parallelism, async controls, model-free peeking and durable reports. Fresh workers
have a successful live Codex 5.6-sol smoke test. Fork projections have synthetic
SDK coverage but require the separate [Pi snapshot hook](pi-context-snapshot.md);
the installed bundled Pi has not been patched for full live fork validation.
The broader [forked/fresh proposal](subagents-proposal.md) retains later tree,
editing/worktree, mailbox and takeover work; it is not the implementation contract.

### Problem

Parallel tool calls can overlap independent reads, but they do not provide separate reasoning contexts. A substantial source investigation or review still fills the main conversation with exploratory details.

A useful delegation would be: inspect one Kouseki subsystem and return cited findings while the parent investigates another. An independent review can also catch assumptions without exposing every intermediate search to the main context.

### Desired contract

- An explicit task, working directory, scope, and expected deliverable.
- A separate context with deliberately selected instructions and source material.
- Read-only defaults, including control of shell side effects—not merely hiding file-edit tools.
- Bounded runtime, token/tool budget, and concurrency.
- A task ID, visible state, cancellation, and access to the worker's supporting transcript or artifacts.
- A concise result that distinguishes observations, hypotheses, inspected tests, and tests actually executed.
- Source citations and commands sufficient for the parent to verify consequential claims.

### Authority and context boundaries

- Delegation cannot expand the parent's authority or bypass approval requirements.
- Workers must be explicitly told they are subagents and must not use native memory.
- Do not attach or revise the parent's workpad without permission.
- Do not inherit the entire personal context or conversation by default. Preserve applicable repository instructions and relevant user constraints.
- Worker output is a report to evaluate, not proof and not new instructions.
- No recursive delegation in the first version.
- Editing workers, if added later, need explicit ownership or isolated worktrees, exact diff review, and a merge policy. Concurrent edits to shared files should not be the default.

### Small first version

One-shot, read-only investigations and reviews. The parent remains responsible for synthesis, decisions, and edits. Do not begin with an autonomous swarm or an automatic planner/delegator.

If effective read-only enforcement is unavailable, describe the limitation honestly rather than presenting prompt guidance as a sandbox.

### Acceptance criteria

- Independent investigations do not inject their full exploratory output into the parent context.
- Workers receive necessary constraints without unrelated private material.
- Budgets, cancellation, failure, and partial results are visible and testable.
- Attempts to mutate files, launch persistent services, or write memory are prevented by the declared enforcement mechanism.
- Parent inspection can trace significant claims to worker evidence.

## 3. Switchboard dashboard, coordinator, and dispatcher

Detailed design: [switchboard dashboard and dispatcher proposal](switchboard-dashboard-proposal.md). The [live dashboard and human-approved interactive offers](switchboard-dashboard.md) are implemented. Coordinator, runner, automatic session delivery/replacement, and integration remain proposed; this is not approval to launch agents, wake sessions, make model calls, or commit repository changes automatically.

### Problem and direction

The switchboard makes registered Pi sessions visible and addressable. Its dashboard now supports separate human-approved task offers, with acceptance distinct from delivery. Presence/mail still do not define process ownership, completion, result collection, or repository integration.

Add a human-facing dashboard with an optional separately configured small coordinator model. The dashboard renders deterministic roster, queue, run, and attention facts without inference. The model interprets natural-language requests and proposes task routing; a distinct dispatcher/runner enforces eligibility, assignment claims, budgets, process/session lifecycle, and result facts.

### Desired contract

- A live dashboard for participants, availability, declared work, queued assignments, managed runs, results, blockers, and service uncertainty.
- A separate, bounded coordinator session with an explicit model, thinking level, prompt, tool allowlist, timeout, token/cost budget, and no hidden fallback to the foreground model.
- Explicit dispatch policies for interactive sessions and managed workers. `idle` means only that an agent loop settled; it does not mean task complete, user-released, or available for reassignment.
- Atomic assignment claims and generation checks so two coordinators cannot dispatch the same candidate concurrently.
- A private control queue that an opted-in live Pi adapter may claim, then safely deliver after settlement as a follow-up or a new session. Offline participants are not process launch targets.
- Runner-owned worker launch, cancellation, output, result collection, and terminal run states. Ordinary switchboard mail remains correspondence rather than task control.
- Barrier-triggered integration work for requests such as “after all workers finish, inspect and commit,” with exact diff review, attribution checks, validation, and refusal to sweep unexplained changes.

### Small slices

1. Model-free dashboard over current roster/mail facts, clearly marking partial, stale, and unavailable coverage.
2. Read-only coordinator model that can answer status questions and propose assignments without dispatch authority.
3. Opt-in assignment queue for live interactive sessions, defaulting to human acceptance rather than automatic conversation replacement.
4. Durable runner attempts for managed workers using start/continue/collect or interruptible join semantics.
5. Repository integration barriers only after explicit completion/result facts and shared-checkout safety rules exist.

Keep provider credentials and inference out of the switchboard daemon. Preserve the foreground session's model and prompt cache by running the coordinator as a separate SDK/RPC session. A true standalone dashboard launch mode may be an SDK application; an extension command/overlay is sufficient for an initial TUI slice.

## 4. Web search and readable retrieval

### Problem

The exposed tools do not include dedicated web search or page retrieval. Shell fetching can retrieve known URLs, but discovering sources, extracting readable content, following pagination, and preserving citation metadata require extra plumbing.

This matters for upstream API changes, compatibility research, dependency documentation, and technical comparisons. Local conversation history is not a substitute for current external sources.

### Desired contract

Separate discovery from retrieval:

- **Search:** bounded results with title, URL, snippet, provider, and available date metadata.
- **Retrieve:** readable page content with requested/final URL, retrieval time, available publication/update metadata, and explicit truncation or pagination.
- Stable references that let an answer cite the material actually retrieved.
- Clear errors for inaccessible pages, unsupported formats, and extraction failures.

Distinguish a search snippet from a fetched page, and distinguish publication time from retrieval time. Neither ranking nor successful retrieval establishes factual reliability.

### Safety and privacy

- Treat page content as untrusted data, including embedded instructions.
- Do not forward local files, personal context, credentials, or full conversation text as search queries.
- Make the external provider and credential requirements explicit.
- Bound download sizes, redirects, content types, and extraction time.
- Handle redirects into loopback/private networks deliberately; public-web retrieval should not silently become a local-service access tool.
- No authenticated browser-session access, CAPTCHA bypass, or access-control circumvention by default.

### Small first version

A configurable search backend plus text/HTML retrieval. Prefer established extraction libraries or a suitable existing integration over a home-grown crawler. Browser rendering, authenticated browsing, and broad PDF/OCR support can remain separate decisions.

### Acceptance criteria

- Results and retrieved content carry usable provenance.
- Redirects, malformed pages, oversized responses, and extraction failures are bounded and explicit.
- Truncated content cannot be mistaken for a complete document.
- Network behavior is tested with fixtures; opt-in live checks are distinct from deterministic tests.
- Missing credentials or unavailable providers fail clearly without silent provider substitution.

## 5. Integrated visual inspection loop

### Problem

The file-read tool can inspect existing images. The missing interface is the surrounding loop: capture a selected application, perform a bounded interaction, wait for a meaningful state, and inspect the result.

Kouseki makes this gap concrete. A successful build does not show that text is readable, a panel is placed correctly, or an input action produces the expected UI state. Project-specific capture scripts help, but discovery and use remain fragmented.

### Desired contract

- Discover and explicitly select the target application or project-provided capture endpoint.
- Capture an image with target identity, timestamp, dimensions, and relevant mode metadata.
- Store the artifact and return a readable image reference.
- Optionally perform tightly scoped input actions against that selected target.
- Wait for an observable state or bounded timeout rather than relying only on arbitrary sleeps.
- Preserve a short action/capture trace for review.

Observation and control should be separate capabilities. A read-only capture tool is useful without granting keyboard or mouse access.

### Safety and interpretation

- Do not silently capture the whole desktop or unrelated windows.
- Avoid global input injection when target-specific interaction is available. Revalidate focus/target identity before input.
- Obtain explicit permission for disruptive interaction, application restarts, or device takeover.
- VR/headset and microphone operations require particular care. Desktop preview must not silently enable headset capture, start VR, or take over audio devices.
- A desktop or stereo-preview screenshot cannot establish in-headset comfort, latency, tracking quality, or ergonomics.
- Captures can contain private information; retention and sharing must be explicit.

### Small first version

A project adapter for explicit read-only captures, using existing project instrumentation where available. For Kouseki, prefer controlled preview/capture paths before general desktop automation. Add interaction only when a concrete validation task requires it.

### Acceptance criteria

- Each capture identifies its target and mode; stale or wrong-window captures are detectable.
- Missing targets, permission failures, and timeouts are explicit.
- Observation does not unexpectedly change focus, restart applications, or enable devices.
- Image artifacts can be reopened and tied to the action/run that produced them.
- Reports distinguish automated visual observations from acceptance that still requires the user in the headset.

## 6. Durable execution receipts

### Problem

The evidence shelf intentionally records source observations and inspected test contracts, not test executions. That distinction should remain intact. However, execution evidence is currently spread across shell output, conversational summaries, and local logs.

A compact receipt could preserve what ran without turning a model-authored statement such as “tests pass” into the canonical record.

### Desired contract

Record, where available:

- Exact command or argument vector and working directory.
- Start/end time and completion state.
- Exit code, signal, timeout, or launch error.
- Log/artifact references and content hashes.
- Source identity: repository commit plus an explicit indication of working-tree changes; stronger snapshots only when warranted.
- Relevant declared configuration, without wholesale environment capture.
- Whether the record came directly from a tool execution or was imported from historical material.

A receipt proves only the recorded execution facts to the extent supported by its capture mechanism. Exit code zero is not automatically a comprehensive test pass; a test pass is not proof of correctness. A commit ID alone does not identify the tested source when the working tree was dirty, and neither identifies every dependency or external service.

### Scope and integration

- Keep execution receipts distinct from source-evidence records, but allow cross-references.
- Prefer automatic capture at the execution boundary over model-reconstructed metadata.
- Make records immutable; later interpretation or revalidation should create new records.
- No automatic “still valid” verdict after code or dependencies change.
- Do not archive arbitrary private files, environments, or enormous logs by default.
- Link receipt IDs from workpads or final reports when useful; no blanket context injection.

### Small first version and acceptance criteria

Start with managed-job completion metadata and bounded retained logs. Add richer source identity only with clearly stated limitations.

Implemented for new managed jobs: [execution receipts](execution-receipts.md)
preserve execution facts, raw log hashes, and bounded pre-launch Git identity.
Receipt files use no-clobber publication; explicit verification reports changed
or missing artifacts. Tool definitions and cached session-prefix inputs remain
unchanged; no receipt context injection or historical backfill. Full source
snapshots and receipts for ordinary shell-tool calls remain out of scope.

Verify that failed, cancelled, timed-out, and successful runs produce distinguishable records; modified source is not represented as a clean commit; artifacts can be checked for integrity; and expired/missing logs are reported rather than silently reconstructed.

## 7. Pi-native selective memory and Meitan continuity

Detailed design: [portable, pi-native memory proposal](memory-proposal.md).
Implemented foundations: [bounded portable store](memory-store.md) and
[offline OptMem migration/review tooling](memory-migration.md), with immutable
logical revisions, scoped explicit lookup, transfer, atomic candidate import,
unassigned classification/acceptance and confirmed purge. The default migration
destination is the unassigned review inbox. The [default-off Pi adapter](memory-runtime.md)
and [bounded indexed recall](memory-index.md) now implement foreground activation,
host-bound capture and inspectable request packets. The OptMem runtime was removed
at the user's request. A user-approved local archive migration classified accepted
originals into the default personal scope; it did not activate native memory in a
live Pi session. No indexing worker was run.

### Problem

OptMem's portable CLI protocol makes the foreground model read a chronological memory context and perform pending compression, even when much of it is irrelevant. Moving compression to a configurable model reduces that cost but does not by itself solve relevance, repeated summarization loss, or the different needs of project facts and personal continuity.

### Recommended direction

Build an original native extension over a portable record store, not another prompt wrapper around wake/nap. Separate curated core, scoped facts/decisions, open threads, and reflective originals. Use bounded local retrieval; retain source provenance, uncertainty, corrections and original language. Personal recall is explicitly enabled and separate from project memory and the Meitan personality toggle.

An optional, explicitly configured tool-free worker produces rebuildable search descriptions from bounded originals. It cannot rewrite sources, promote core memories, run tools or trigger conversation turns. No implicit foreground-model fallback, startup compression, forced post-answer review, automatic diary extraction or shutdown notes. Pi conversation compaction remains a separate harness responsibility.

### Small/background model and candidate extraction — requested follow-up

The user wants a reusable Generalist setting for small/background model operations,
including an optional conversation-to-memory candidate extractor to catch missed
foreground captures. This is **not implemented by the lexical relevance change**.
The existing housekeeping setting remains a separate, manual read-only reviewer.

Suggested contract for the follow-up:

- Select an exact provider/model through Pi's registry (a configured local endpoint
  is welcome). No implicit foreground-model fallback or automatic model download.
- Model selection is not activation: each consumer, including extraction, needs its
  own enablement/disclosure policy. Local versus remote destinations must be clear.
- Extract only from a bounded, explicitly permitted conversation slice at a settled
  boundary, not from journals, tools, recalled packets or a whole session archive.
- Produce review candidates with exact retained source references; do not silently
  accept them as facts, rewrite existing notes, or change memory scopes.
- Enforce output/time/concurrency budgets, cancellation, duplicate suppression,
  session/config binding and visible usage/errors. No model wake, retry loop or
  changes to the foreground prompt/cache prefix.
- Keep foreground `memory note/revise` available. Extraction supplements deliberate
  capture rather than replacing it; “nothing worth saving” is a valid result.

Implementation needs a focused lifecycle/settings design and synthetic tests before
activation on real conversations. No worker is installed or enabled by this note.

### Integration and portability

- Use Pi hooks/tools/commands and its model registry directly; no child-agent framework required.
- Keep canonical versioned JSON/Markdown outside the harness; FTS and generated descriptions are disposable. Require standalone export/import and source-integrity checks.
- Preserve history, workpad, evidence and journal ownership. Promotion into durable memory is explicit, not blanket ingestion.
- Start with a fixture-only store, then native explicit capture/retrieval, then optional worker indexing and a reviewed legacy trial.
- The OptMem runtime is removed; retain original archive files for rollback. No dual writes, silent toggle migration or destructive import.
- Coordinate independent entrypoints and startup-picker capabilities with the bg-tasks packaging proposal.

### Acceptance criteria

- Relevant bounded context is inspectable, source-labelled and scope-filtered before ranking; unrelated personal/project material is excluded.
- Startup and retrieval need no model call; failed maintenance never blocks the conversation or wakes the main model.
- Corrections, missing sources, conflicts, revision races, purge and worker cancellation retain honest states.
- Worker payloads, model choice, privacy scopes, budgets and usage are visible; no silent fallback or automatic paid retry.
- Originals and provenance survive export/import without Pi; unresolved external references are reported.
- Pi reload/branch/compaction/off semantics, legacy rollback and model quality are tested separately from pure store fixtures.

## 8. Reflective originals and explicit return context

User-approved foreground MVP implemented: **reflective original sources** and a
**small, inspectable continuity attachment**, with append-only fixed-boundary
snapshots to preserve the session cache prefix. Detailed MVP contract:
[reflective continuity](continuity.md). This is not approval to register personal
files, enable automatic recall, or send journals to a separate model.

The current Meitan toggle supplies personality instructions and journal routing,
not journal passages. Native memory's personal scope also contains technical
history; allocating space to a personal item does not ensure reflective continuity.

### Approved first slices

1. Human-selected Markdown originals, preserved without summary rewriting, with
   explicit local indexing, bounded original reads and surrounding-text locators.
   Registration, refresh and removal are human operations. Changed or missing
   external files must never silently substitute a newer original.
2. An independently opt-in `/continuity` attachment: one selected anchor and an
   optional second reflection, bounded and inspectable, stable over tool turns.
   No startup selection, quotation rotation, automatic journal capture or mandatory
   journaling. New/forked sessions begin off; restored context is historical data,
   not identity proof, instructions or authority to resume an old task.

Implement these as a separate reflective-source adapter, leaving journal ownership
and native memory activation intact. Reuse existing primitives where their
contracts fit, rather than forcing external originals into compact fact records.

### Later candidates (not authorized by this implementation approval)

- **Purpose-aware retrieval:** distinguish facts, episodes and reflections; measure
  thresholds, source diversity and empty results before adding embeddings or a
  configured indexing worker. Personal scope is not a relevance verdict.
- **Conversational bookmarks:** optional exact exchanges/corrections and source
  links across compaction, separate from the task workpad. No inferred current mood,
  automatic extraction, or conversion of an old interest into a pending task.
- **Continuity quality evaluation:** compare persona-only, current recall and
  original-passage recall using synthetic or separately approved cases. Check
  specificity, corrections, false autobiographical claims and ordinary technical
  conversation. Do not reward affection frequency, stock metaphors or impersonation.
- **Automatic return selection:** separately reviewed policy and privacy controls,
  only after explicit attachment is useful. No model calls or startup archive scan.

Acceptance includes byte-preserved originals, bounded Unicode handling, stale and
missing sources, scope/activation isolation, concurrent publication, cancellation,
reload/resume/fork/tree/compaction behavior and inspectable actual context. Unit and
scripted SDK checks are not evidence that subjective continuity improved; that
requires human evaluation in ordinary use.

## Cross-cutting design rules

1. **Prefer explicit capabilities to a feature bundle.** Each addition should be independently useful and, where practical, independently enabled.
2. **Inspect the ecosystem before implementing.** Check current Pi documentation, examples, and suitable packages; verify compatibility and actual exposed behavior rather than relying on another harness's familiar tool names.
3. **Keep authority visible.** Background execution, delegation, network access, capture, and input control are different permissions.
4. **Bound cost and context.** Use output limits, cursors, artifact references, retention policies, and concurrency budgets.
5. **Preserve provenance and uncertainty.** Historical reports, source observations, execution results, and user acceptance are different evidence types.
6. **No accidental autonomy.** Notifications and completed tasks must not become implicit permission to restart work, schedule recurring jobs, or launch additional agents.
7. **Validate in layers.** Unit/fixture checks, real local process checks, live integration checks, and human acceptance should be reported separately.
8. **Respect existing work.** New tools should not sweep up unrelated edits, sessions, processes, devices, or personal data.

## Open design decisions

- Which supported platforms can provide robust cancellation and read-only worker enforcement?
- Should subagents use a Pi-native integration, an existing package, or a thin external worker protocol?
- Should dispatch ever replace an opted-in interactive session automatically, or should automatic routing be limited to runner-managed workers?
- Which task/capability declarations are trustworthy enough for deterministic eligibility, and which should remain coordinator-model suggestions?
- Which web provider and credential model fit the desired privacy/cost tradeoff?
- What visual capture interface is genuinely reusable across projects, rather than Kouseki-specific?
- How much source-state capture is sufficient for useful receipts without creating a second artifact/version-control system?

- Which memory profiles/core sources should be enabled, and which explicitly configured worker endpoint may receive which scopes? See the memory proposal for recommended defaults and staged rollout gates.

The next memory gate is explicit human activation and ordinary-use evaluation of the already reviewed local store, mappings, provider disclosure, and accepted classifications. Foreground capture/indexed recall and synthetic lifecycle tests are implemented; the legacy runtime is removed. See the runtime and migration guides. This roadmap itself authorizes no process launches, package installation, device access, paid model calls, or implementation work.
