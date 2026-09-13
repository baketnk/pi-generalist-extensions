# Tooling roadmap

This document outlines gaps identified while considering ordinary coding work and larger, interactive projects such as Kouseki. It is a proposal, not an approved implementation plan or a promise to reproduce another harness's feature set.

The goal is a balanced set of explicit, portable capabilities: tools that reduce real friction while keeping authority, process ownership, and evidence clear.

## Current baseline

The environment already provides file reads and edits, shell execution, and parallel tool calls. This package adds several complementary capabilities:

- **History search/read:** bounded, cited access to earlier conversations.
- **Workpad:** in-session revisable task understanding, separate from a checklist or out-of-session durable memory.
- **Evidence shelf:** immutable source excerpts with explicit freshness checks.
- **Tasks and questions:** progress tracking, blocking clarification, and asynchronous user input.
- **Optional personality and compact memory:** independently enabled continuity aids.

These provide useful remembering and organizing primitives, but durable memory still delegates bulk wake and compression to the foreground model. The remaining gaps include selective continuity as well as execution, delegation, external information retrieval, and observation.

A missing first-class interface does not imply that the underlying capability is impossible. Shell commands, local programs, and project-specific scripts can often substitute. The question is where repeated improvisation creates enough lifecycle, safety, or context-management cost to justify a dedicated interface.

## Suggested priorities

| Capability | Suggested priority | Main benefit |
| --- | --- | --- |
| Managed background jobs | First execution capability | Reliable long-running work without ad hoc process management |
| Pi-native selective memory | Foreground MVP; live review pending | Relevant continuity without foreground compression; portable originals |
| Bounded subagents | Next candidate | Isolated investigations and independent reviews |
| Web search and readable retrieval | Next candidate | Research without repeatedly building fetching and extraction plumbing |
| Visual inspection loop | Project-driven | Observe and validate interactive applications |
| Execution receipts | Small supporting capability | Preserve what actually ran and under which source state |

Managed jobs remain the first execution recommendation. Pi-native memory is now a user-requested design track, independent of managed jobs or subagents; its optional worker can use direct Pi model calls. Implementation ordering should follow demonstrated needs and separate approval. Receipts may naturally begin as part of managed jobs rather than as a separate extension.

## 1. Managed background jobs

Detailed design: [focused bg-tasks proposal](bg-tasks-proposal.md), including lifetime, cancellation, output cursors, notifications, acceptance gates, and independent package entrypoints. Proposed only; not implemented.

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

## 2. Bounded subagents

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

## 3. Web search and readable retrieval

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

## 4. Integrated visual inspection loop

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

## 5. Durable execution receipts

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

Verify that failed, cancelled, timed-out, and successful runs produce distinguishable records; modified source is not represented as a clean commit; artifacts can be checked for integrity; and expired/missing logs are reported rather than silently reconstructed.

## 6. Pi-native selective memory and Meitan continuity

Detailed design: [portable, pi-native memory proposal](memory-proposal.md).
Implemented foundations: [bounded portable store](memory-store.md) and
[offline OptMem migration/review tooling](memory-migration.md), with immutable
logical revisions, scoped explicit lookup, transfer, atomic candidate import,
unassigned classification/acceptance and confirmed purge. The default migration
destination is the unassigned review inbox. The [default-off Pi adapter](memory-runtime.md)
and [bounded indexed recall](memory-index.md) now implement foreground activation,
host-bound capture and inspectable request packets. The OptMem runtime was removed
at the user's request. No live migration/activation or indexing worker was run.

### Problem

OptMem's portable CLI protocol makes the foreground model read a chronological memory context and perform pending compression, even when much of it is irrelevant. Moving compression to a configurable model reduces that cost but does not by itself solve relevance, repeated summarization loss, or the different needs of project facts and personal continuity.

### Recommended direction

Build an original native extension over a portable record store, not another prompt wrapper around wake/nap. Separate curated core, scoped facts/decisions, open threads, and reflective originals. Use bounded local retrieval; retain source provenance, uncertainty, corrections and original language. Personal recall is explicitly enabled and separate from project memory and the Meitan personality toggle.

An optional, explicitly configured tool-free worker produces rebuildable search descriptions from bounded originals. It cannot rewrite sources, promote core memories, run tools or trigger conversation turns. No implicit foreground-model fallback, startup compression, forced post-answer review, automatic diary extraction or shutdown notes. Pi conversation compaction remains a separate harness responsibility.

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

## 7. Reflective originals and explicit return context

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

- Should managed jobs survive Pi exit, and who owns cleanup after a crash?
- Which supported platforms can provide robust cancellation and read-only worker enforcement?
- Should subagents use a Pi-native integration, an existing package, or a thin external worker protocol?
- Which web provider and credential model fit the desired privacy/cost tradeoff?
- What visual capture interface is genuinely reusable across projects, rather than Kouseki-specific?
- How much source-state capture is sufficient for useful receipts without creating a second artifact/version-control system?

- Which memory profiles/core sources should be enabled, and which explicitly configured worker endpoint may receive which scopes? See the memory proposal for recommended defaults and staged rollout gates.

The next memory gate is human review of an inactive real snapshot, target store, scope mappings, candidate classifications and provider disclosure, followed by explicitly approved native activation. Foreground capture/indexed recall and synthetic lifecycle tests are implemented; the legacy runtime is removed. See the runtime and migration guides. Managed jobs remain an independent execution track. This roadmap itself authorizes no process launches, package installation, device access, personal-data migration, paid model calls, or implementation work.
