# Astra harness efficiency and Codex-style `exec`

Status: **comparative observation and design recommendation; no `exec` implementation is approved or included**.

This note records a 2026-09-13 review of recent longer Pi, Codex, and OMP sessions, with model round-trips treated as the primary cost for GPT-6 Astra. It also distinguishes Codex's model-facing Code Mode `exec` tool from ordinary command execution and evaluates whether an equivalent belongs in Pi.

## Decision summary

The recent tooling work is helping Pi. Pi now has broadly competitive capability, better parallel reads, safer coordinated edits, managed finite jobs, bounded history access, and more explicit execution/evidence state. The newest tools directly address failure and recovery costs seen in older sessions.

The available evidence does **not** yet show that Pi has closed Codex's round-trip advantage on bounded autonomous implementation tasks. The cleanest Codex examples use fewer Astra responses because one model-facing `exec` call can run JavaScript that invokes, combines, filters, loops over, and conditionally dispatches multiple nested tools. That is a different capability from Pi's built-in `bash` and from the extension-only `pi.exec()` helper.

Recommendation:

1. Do not add a renamed duplicate of Pi's `bash`; it would add schema and prompt cost without providing Codex's main benefit.
2. Do not implement model-authored JavaScript with Node `eval`, `node:vm`, Bun globals, or direct extension-process access. Those are not an adequate security boundary.
3. Keep using Pi's native sibling-tool parallelism, multi-edit `edit`, `apply_patch`, and completion-driven `bg_tasks` immediately.
4. Investigate a **Pi-core nested-tool dispatch API plus a sandboxed code-mode host**. An extension alone cannot currently reproduce Codex's semantics safely or generically because `pi.getAllTools()` exposes metadata, not a supported method for invoking arbitrary active tools through Pi's validation, hooks, permissions, cancellation, and result pipeline.
5. Gate any implementation on an Astra A/B evaluation. The feature is worthwhile only if it reduces model cycles without increasing wrong mutations, hidden partial failures, prompt-cache churn, or operational risk.

## What counts as a round-trip

For this review, one model response cycle counts as one round-trip:

- Pi and OMP: one assistant message, including a message containing multiple sibling tool calls.
- Codex: one recorded token-usage/model-response cycle.
- Several tools emitted by one model response still count as one round-trip.
- A Codex Code Mode `exec` call counts as one outer tool call even if its JavaScript invokes several nested tools.

User steering turns were counted separately. Harness-injected environment or coordination messages were excluded where identifiable.

This is a trajectory review, not a controlled benchmark. Tasks differ in complexity, elapsed time includes different amounts of command execution and user delay, and session formats do not expose perfectly identical accounting. Counts are useful directional evidence, not a claim that one harness is faster by a precise percentage.

## Sample and aggregate observation

The broad sample selected sessions beginning on or after 2026-09-04 that used GPT-6 Astra, contained at least 60 model cycles, invoked tools, and contained a real user task.

| Harness | Sessions | Median model cycles | Median visible tool calls per cycle |
| --- | ---: | ---: | ---: |
| Pi | 18 | 111 | 1.33 |
| Codex | 18 | 123.5 | 0.96 |
| OMP | 8 | 119.5 | 1.54 |

The broad medians make Pi look competitive, but they mix long conversations, live debugging, design work, and implementation. Codex's visible tool-call ratio is also misleading in Code Mode: an outer `exec` cell can contain many nested calls.

A small low-steering slice—at most two identifiable real user turns—was more relevant to autonomous task completion:

| Harness | Sessions | Median model cycles | Caveat |
| --- | ---: | ---: | --- |
| Pi | 8 | 111 | Useful sample, but most substantial sessions predated the newest patch/orchestration affordances or built them. |
| Codex | 2 | 64.5 | Too small for a stable median, but both trajectories were unusually coherent. |
| OMP | 3 | 89 | Small and task-mixed; not evidence of a general OMP advantage. |

The low-steering comparison and manual trajectory review both suggest a remaining Codex edge, but the sample is too small and confounded to call it a benchmark result.

## Representative trajectories

| Harness/session | Work | Model cycles | Visible tool calls | Real user turns | Observation |
| --- | --- | ---: | ---: | ---: | --- |
| Pi `01a08e16-43c5…` | Kouseki WORK-009 physics spike | 157 | 261 | 2 | Successful and autonomous, but fragmented into 98 reads, 76 edits, and 73 shell calls. |
| Pi `01a09b34-0ccf…` | Pose foundation and WORK-084 seating | 163 | 284 | 2 | Delivered and tested the seat work; correctly deferred WORK-085 behind physical acceptance. High read/edit granularity remained. |
| Pi `01a09c67-3886…` | `apply_patch` no-op compatibility | 38 | 73 | 2 | A good newer small-task result: prior-art review, implementation, tests, docs, full suite, and typecheck in roughly eight elapsed minutes. |
| Codex `01a09b84-bed4…` | Kouseki WORK-087 lightweight fixtures | 68 | 67 outer calls | 2 | Completed code, tests, repeated profiling, evidence, docs, and planning updates. One user correction addressed sandbox mismatch. |
| Codex `01a087e9-c2d5…` | Six-part VR workbench batch | 157 | 154 outer calls | 4 | Broad implementation and verification; comparable cycle count to Pi's large feature sessions. |
| Codex `01a08960-468a…` | Creature foundation and corgi | 94 | 88 outer calls | 5 | Substantial feature, persistence, extensibility, documentation, commit, and multiple suites. |
| OMP `01a0836e-2e2e…` | OBS/headset-view live debugging | 255 | 290 | 7 | Eventually diagnosed a real NVIDIA/Wayland presenter hang and validated a live fix, but an early action disrupted the user's workspace. |
| OMP `01a06eb5-cfd9…` | VR launcher, HUD, voice and environment work | 190 | 297 | 7 | Strong live-machine integration; many granular tool cycles and user hardware feedback. |

### Quality, not just count

Pi's longer tasks generally showed good scope discipline, preserved unrelated work, distinguished automated checks from headset acceptance, and completed without repeated user rescue. The main cost was repeated read/edit reasoning.

Codex's best bounded sessions maintained a compact plan and used dense shell/tool batches. Its managed sandbox created avoidable friction in WORK-087: local sockets and SDL/display tests failed until the user explained that the normal harness is unsandboxed. Lower model-cycle count did not eliminate environment mismatch.

OMP retained an advantage for operations that directly exercised live VR, OBS, RPC, and debugger workflows. The same session also showed why tool power alone is not efficiency or safety: it needed many model cycles and initially caused disruption before converging on the correct diagnosis.

## What the improved Pi tools are buying

The improvements map directly to observed costs:

- **Native parallel tool execution** lets one Astra response issue independent reads or searches together.
- **Multi-replacement `edit`** reduces one-edit-per-generation loops within a file.
- **`apply_patch`** expresses coherent multi-file/multi-hunk changes and performs bounded preflight, while reporting partial commit failures honestly.
- **`bg_tasks`** avoids holding an ordinary shell call open, supports completion notification instead of model polling, and preserves bounded incremental logs and receipts.
- **`history_search` / `history_read`** replace manual filesystem discovery and large transcript reads with bounded cited retrieval. This review itself used one parallel search cycle across three harnesses and parallel drill-down.
- **Workpad, evidence, tasks, questions, and switchboard** improve continuity, provenance, and coordination. They principally improve correctness and recovery; they save model cycles only when they prevent rediscovery or user rescue.

These tools can also add round-trips if used ceremonially. Reading and then immediately updating a workpad, emitting a plan for a short task, polling a background command, or inspecting status after an already conclusive result consumes another Astra response. Tool guidance should favor dense use where it changes the outcome.

## Three different things named `exec`

### 1. Pi extension API `pi.exec()`

`pi.exec(command, args, options)` is an extension-author helper. Extension TypeScript can launch a subprocess and receive `stdout`, `stderr`, exit code, and killed state. It is not automatically a model-facing tool. The model can use it only if an extension registers a tool that calls it.

### 2. Codex nested `exec_command`

Codex's command runner accepts shell text plus controls such as:

- `workdir` and optional shell selection;
- login-shell policy;
- pipe or optional PTY mode;
- a default 10-second yield window, bounded to 250–30,000 ms on Unix;
- an output-token budget;
- sandbox/permission request fields; and
- optional environment selection.

A command that finishes within the yield window returns output and an exit code. A still-running command returns a numeric session ID. `write_stdin` can send characters or poll that process, with its own yield/output limits. Command execution flows through Codex's environment selection, sandbox and approval logic, hooks, cancellation, output truncation, and process manager.

Pi divides this space differently:

- Built-in `bash` runs one noninteractive shell command to completion, streams combined stdout/stderr, has no default timeout, kills the process tree on timeout/abort, and retains the last 2,000 lines or 50 KiB with a full-output temporary file when truncated.
- `bg_tasks` owns finite asynchronous jobs, bounded logs, cancellation, completion notification, and receipts, but intentionally has no interactive stdin or PTY.

A direct port of `exec_command` alone would overlap those two Pi capabilities. PTY/stdin support may be useful independently, but it is not what produced the main round-trip gain in the sampled Codex sessions.

### 3. Codex Code Mode `exec`

This is the important feature. From the model's perspective, Codex exposes a freeform tool named `exec`. The tool input is raw JavaScript, not JSON or a shell script. A typical call observed in WORK-087 was structurally equivalent to:

```js
const results = await Promise.allSettled([
  tools.exec_command({ cmd: "python3 kouseki.py catalog --json", workdir, max_output_tokens: 20000 }),
  tools.exec_command({ cmd: "python3 tools/planning.py show WORK-087", workdir, max_output_tokens: 20000 }),
  tools.exec_command({ cmd: "git status --short", workdir, max_output_tokens: 12000 }),
]);
for (const result of results) {
  text(result.status === "fulfilled" ? result.value.output : String(result.reason));
}
```

The actual mechanics at inspected Codex revision `ca6fb194b695` are:

1. Codex starts a fresh V8 isolate and evaluates the JavaScript as an asynchronous module.
2. The isolate has no Node API, direct filesystem, network, or console access.
3. Enabled nested tools appear as asynchronous methods on global `tools`, with generated TypeScript-like input/output declarations in the `exec` description.
4. Nested calls are delegated back through Codex's normal tool router. They retain schema checks, hooks, approvals, sandboxing, cancellation, telemetry, and tool-specific result adaptation.
5. JavaScript can use ordinary control flow, `Promise.all`/`Promise.allSettled`, loops, filtering, and data-dependent follow-up calls without another model response.
6. Only values passed to helpers such as `text()`, `image()`, `audio()`, or `generatedImage()` become the direct model-visible result. This allows local filtering and aggregation before context injection.
7. `store()` and `load()` retain serializable values for later `exec` cells in the same session. `notify()` can emit an immediate additional output item.
8. `yield_control()` can return accumulated output while the script continues. A long-running script yields a cell ID; a separate model-facing `wait` tool resumes, terminates, or retrieves later output.
9. A first-line pragma can set the outer script yield window and direct output-token budget.
10. When evaluation finishes, the isolate ends and unawaited promises are discarded.

### Observed nesting density

| Codex session | Outer `exec` cells | Nested tool calls found in cell source | Cells using `Promise.all*` | Maximum nested calls in one cell |
| --- | ---: | ---: | ---: | ---: |
| WORK-087 `01a09b84-bed4…` | 66 | 100 | 11 | 5 |
| Six-part workbench `01a087e9-c2d5…` | 151 | 202 | 6 | 3 |
| Corgi foundation `01a08960-468a…` | 86 | 261 | 24 | 7 |

The corgi session's median was three nested calls per outer cell. This is why counting only Codex's outer tool calls understates the work performed between Astra generations.

## What Code Mode adds beyond parallel calls

Pi already executes sibling tool calls from one assistant message concurrently. That covers the simplest case: “read these four independent files.” A Code Mode layer adds four material capabilities:

1. **Data-dependent sequencing without a model response.** Read a manifest, derive a list, then inspect each listed path locally.
2. **Local reduction.** Return only failed tests, changed files, selected fields, or a bounded summary rather than injecting every raw nested result.
3. **Programmatic fan-out.** Map a bounded collection into nested calls when the collection is discovered at runtime rather than known when Astra formed the response.
4. **Mixed error handling.** Use `Promise.allSettled`, retry or skip a specifically classified failure, and preserve successful independent results without another reasoning cycle.

These properties are particularly valuable for Astra because provider latency and reasoning cost are paid once for the whole orchestration cell.

They can also hide useful evidence. If model-written code filters incorrectly, forgets to print a failure, launches unawaited promises, or performs too much work in a loop, the next model response receives an incomplete view. The runtime therefore needs durable nested-call traces and hard budgets even when direct cell output is compact.

## Can this be ported as a Pi extension today?

### A shell-only imitation: technically easy, strategically weak

An extension could register `exec` and pass JavaScript or a declarative list to `pi.exec()`. That would only orchestrate subprocesses the extension knows how to launch. It would duplicate `bash`, potentially bypass shell-tool hooks and session environment semantics, and would not compose `read`, `edit`, `apply_patch`, history, evidence, questions, switchboard, MCP, or future tools.

A declarative `shell_batch` could run several commands concurrently, but one Pi `bash` call can already use shell composition, and Astra can already emit parallel sibling calls. This does not justify another always-visible tool.

### A generic safe port: blocked on core/runtime support

The installed extension API exposes active tool metadata through `pi.getAllTools()` and activation through `pi.setActiveTools()`. It does not expose a supported “invoke this active tool as a nested call” operation.

A correct dispatcher must preserve:

- current-turn schema validation and argument preparation;
- `tool_execution_*`, `tool_call`, and `tool_result` event behavior;
- mutation queues for file tools;
- project trust, sandbox and permission gates;
- cancellation and interruption semantics;
- result typing, image handling, truncation, and session recording;
- nested-call source attribution and complete traces; and
- prevention of recursive `exec` calls.

Reaching into Pi internals from this package would create a version-fragile and potentially unsafe second tool router. Re-registering private copies of every built-in and extension tool would diverge similarly.

JavaScript isolation is the other blocker. Node's `vm` documentation does not present it as a security mechanism, and removing obvious globals does not make arbitrary model-authored JavaScript safe inside the Pi process. A credible implementation needs a separate constrained host or a genuinely sandboxed embedded runtime with CPU, wall-time, memory, output, nested-call, and concurrency limits.

## Recommended Pi architecture

Treat Code Mode as a Pi-core capability with an optional extension/user interface, not as a one-file shell wrapper.

### Phase 0 — use and measure the current surface

- In Astra guidance, explicitly batch independent reads and searches in one response.
- Prefer multi-location `edit` and `apply_patch` to repeated single edits.
- Use `bg_tasks` completion delivery instead of status polling.
- Add session analysis that distinguishes model cycles, outer tool calls, and nested/batched operations.

This establishes a fair baseline using capabilities that already exist.

### Phase 1 — supported nested-tool dispatch

Add a Pi API conceptually similar to:

```ts
ctx.invokeTool(name, args, {
  signal,
  source: { kind: "orchestrator", id: cellId },
});
```

The exact API is undecided. It must call the same registered definition and lifecycle pipeline as a direct model tool, reject inactive/unknown tools, prevent recursion, and record nested invocations. It must not expose raw execute closures as ambient extension authority.

A small declarative parallel/composition tool could validate this dispatcher before JavaScript is introduced.

### Phase 2 — isolated orchestration runtime

Provide a fresh, capability-free isolate per cell. Give it only brokered nested-tool functions and bounded output helpers. Initial limits should include:

- maximum source bytes;
- CPU and wall-clock deadline;
- isolate memory ceiling;
- maximum nested calls and nesting depth of one;
- maximum concurrent calls;
- aggregate nested output and direct output budgets;
- cancellation propagation; and
- rejection of unawaited/incomplete work where detectable.

Do not provide Node/Bun imports, process/environment access, direct filesystem/network APIs, `eval` escape paths, or persistent timers.

### Phase 3 — opt-in model tool

Expose `exec` and possibly `wait` only for models that use the interface reliably. Keep direct tools available during the first evaluation; Code Mode-only tool exposure is a later prompt-size/cache experiment.

Tool definitions and descriptions must remain stable over ordinary turns. Dynamically changing the nested catalog can invalidate provider cache prefixes. If nested tools are loaded lazily, use Pi's native deferred-tool support and append definitions at stable tool-result boundaries rather than rebuilding earlier prompt content.

The initial implementation should omit persistent cross-cell `store/load`, images/audio, interactive PTYs, and permission escalation unless a measured task requires them. They are useful Codex features but expand the security and lifecycle surface beyond the core round-trip hypothesis.

## Acceptance and evaluation gates

### Correctness and safety

- Every nested call runs through the same validation, hook, permission, mutation, cancellation, and result pipeline as a direct call.
- Nested calls and their raw bounded results remain inspectable even when the script prints only a reduction.
- Unknown, inactive, recursively invoked, or schema-invalid tools fail clearly.
- A script failure cannot convert a failed mutation into success or conceal an uncertain/partial `apply_patch` result.
- Abort, timeout, reload, session replacement, compaction, and process exit have explicit cell and nested-call outcomes.
- Infinite loops, promise floods, huge allocations, huge output, long lines, invalid Unicode, and delayed callbacks are bounded.
- No isolate code can access ambient filesystem, network, credentials, process APIs, extension closures, or another session except through granted nested tools.
- Parallel file mutations still obey Pi's per-file queue and each tool's own cross-file failure contract.

### Astra A/B benchmark

Use the same repository snapshot, instructions, model/thinking setting, and acceptance tests. Include:

- multi-file inspection followed by a targeted edit;
- a broad feature with tests and docs;
- test-failure triage where only failures should reach the model;
- a data-derived fan-out task;
- repetitive/ambiguous edit recovery; and
- an environment-limited command requiring honest diagnosis.

Measure:

- model response cycles and provider latency;
- user steering/rescue turns;
- task and test correctness;
- wrong-target or partial mutations;
- outer and nested tool calls;
- tool errors and retries;
- input/output tokens, including tool descriptions and raw results;
- prompt-cache reuse across ordinary turns; and
- wall time separated into model, tool, and user wait time.

A useful initial gate would require a clear reduction in median Astra cycles on composition-heavy tasks with no correctness regression and no new unbounded or hidden-failure class. A small win on shell-only tasks is insufficient justification for the added runtime.

## Practical conclusion

Codex-style Code Mode feels important for this usage because Astra round-trips matter and the sampled sessions demonstrate real nested-call density. It is probably the largest remaining general orchestration advantage visible in Codex.

It is **not** important to port `exec_command` as another shell tool. Pi already has the necessary direct shell and managed-job pieces. The valuable port is the sandboxed, brokered ability to compose existing tools inside one model response.

That should be pursued deliberately at the Pi core/runtime boundary. Until that boundary exists, the safest high-value path is to improve Astra's use of Pi's existing parallel calls and patch/edit batching, then measure fresh substantial sessions. A clever extension-process `eval` would imitate the interface while discarding the properties that make Codex's implementation trustworthy.

## Inspected references

Local source observations are revision-specific, not promises about future upstream behavior:

- Codex HEAD `ca6fb194b695`:
  - `/mnt/secondary/workspace/codex/codex-rs/code-mode-protocol/src/description.rs`
  - `/mnt/secondary/workspace/codex/codex-rs/core/src/tools/code_mode/`
  - `/mnt/secondary/workspace/codex/codex-rs/core/src/tools/handlers/shell_spec.rs`
  - `/mnt/secondary/workspace/codex/codex-rs/core/src/tools/handlers/unified_exec/`
- Installed Pi 0.85.1:
  - `docs/extensions.md`
  - `docs/sdk.md`
  - `docs/environment-variables.md`
  - `dist/core/tools/bash.js` and its source map
  - `examples/extensions/{bash-spawn-hook.ts,interactive-shell.ts,truncated-tool.ts}`
- Historical session evidence:
  - Pi `01a08e16-43c5-746a-b20b-c12abac74cf6`
  - Pi `01a09b34-0ccf-742a-891a-04b01729c594`
  - Pi `01a09c67-3886-742b-b438-60685008cd44`
  - Codex `01a09b84-bed4-72b2-ab71-177257f7a203`
  - Codex `01a087e9-c2d5-7333-a47c-1e731328a164`
  - Codex `01a08960-468a-7fc0-bfcd-28f3134079ae`
  - OMP `01a0836e-2e2e-7234-8cd2-6355ac75117f`

Historical session reports establish what was recorded in those trajectories, not current source state or a new test execution.
