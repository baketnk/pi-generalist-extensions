# Background completion delivery

Implemented in `extensions/bg-tasks.ts` and `lib/bg-tasks/completion.ts`.
This is an extension-level improvement, not a replacement for Pi's scheduler.

## Delivery contract

- Eligible settled results enter an **unsent** completion queue. Existing messages,
  tool results, prompt sections, and tool definitions are never rewritten as jobs
  progress. Durable execution receipts remain separate from notification packets.
- While the agent is working, pending results are batched at `turn_end`. On the
  local fork they become appended boundary entries with `continue: true`: a
  naturally required tool follow-up satisfies that continuation, rather than
  adding a later follow-up request. Stock Pi uses one steering message instead.
- At most eight completions are included per packet. Remaining queued observations
  stay available for a later boundary. A packet states the remaining count.
- When idle, a fixed **75 ms window** from the first pending completion combines
  nearby results into one wake. It is not reset by every subsequent completion.
  Busy agents are not interrupted by a timer; the next lifecycle boundary drains
  the queue. `agent_settled` closes the final-settlement race on the fork. There is
  no timer-based model polling and no change to global human follow-up settings.
- Already queued observations can join the next ordinary prompt without an extra
  wake. Completions arriving after submission are delivered later, not inserted
  into the submitted prefix.
- A final response with attended work still pending receives a disposition reminder
  in the same packet: wait, cancel, or ignore. This is intentionally not a new
  permission to start more work.

## Completion evidence

Packets contain job ID/label, execution state, exit code/signal, stop reason,
cleanup state, capture truncation, and a bounded output tail. The runtime reads only
that page, not the whole log. Output failures are explicit, not empty success.

Each tail reads at most 2 KiB; JSON-escaped preview text is also bounded to 2 KiB.
`output.start > 0` indicates omitted earlier bytes; `outputPreviewTruncated` means
further display shortening. `outputTruncated` means capture itself was truncated.
Offsets still describe the underlying page. `readFromStart` is a cursor for
`bg_tasks output`; earlier evidence remains explicitly retrievable. With bounded
runtime IDs/fields, an eight-result message is under 32 KiB. Output is untrusted
command data. Exit 0 alone is not a claim that acceptance tests or the task passed.

`wait next/all` still selects unfinished jobs at call time, including exited
processes draining output/finalizing receipts. It additionally returns queued
eligible completions present when the wait began, up to the packet bound. It
includes the same output packets and acknowledges returned observations so a
later completion wake does not repeat them. Jobs started later are not added to
its wait set. Interrupted waits leave observations available.

`ignore id` also silences a settled but unsent completion; cancel suppresses the
completion already observed by its result. Neither retracts messages already
submitted. `notify=errors/off` retains the existing policy.

## Lifecycle and failure behavior

- Abort/error suspends automatic completion wakes. Jobs continue, matching the
  existing launch-only cancellation contract. Pending observations can be shown
  on the next prompt or a successful retry boundary; they do not restart an
  aborted agent on their own.
- Reload, session replacement, confirmed tree navigation, and graceful exit stop
  the old runtime and fence its pending/in-flight delivery. Tree navigation creates
  a fresh runtime, so old-branch results do not wake the new branch.
- Output reads recheck delivery eligibility and queue membership before submitting.
  Explicit wait/ignore/cancel and runtime replacement can invalidate an in-flight
  packet without modifying earlier context.
- A metadata write failure does not prevent signalling an owned process during
  shutdown. Persistence errors are reported separately from execution facts.
- Enqueue failures are not retried automatically because acceptance can be
  ambiguous. A UI warning is attempted; durable execution results remain available
  for explicit inspection. This is not an exactly-once durable messaging system.
- The queue is runtime-local, not crash recovery or automatic replay after reload.
  Compaction and explicit configuration changes remain lifecycle boundaries, not
  promises of unchanged prefixes.

## Comparison: Unreal Agent

Inspected https://github.com/unreallabsai/unreal-agent at `b7c9bf1` (source only):

- `harness/coordinator/loop.go`: `processEvents` drains available inbox/operation
  updates before deciding to request a model response. New tool calls get a
  one-second grace period, ending early when their tracked calls complete.
- `harness/contextbuilder/submission_test.go`: tests distinguish unsent input from
  committed submissions and assert that later completions do not mutate previously
  built requests.

The useful shared idea is **gather ready observations before paying for a model
request, and freeze submitted context**. We use Pi's existing turn boundaries,
not a new operation/coordinator system. We do not copy its running-tool placeholders,
heartbeat requests, or make ordinary Pi tools asynchronous. Our idle window is a
small burst debounce, not its per-tool-batch grace algorithm. No upstream code was
copied, and no comparative performance claim is made.

## Regression checks

```sh
bun test tests/bg-tasks-completion.test.ts tests/bg-tasks.test.ts \
  tests/bg-tasks-output.test.ts tests/execution-receipt-cache.test.ts
PI_FORK_ROOT=/path/to/pi-mono bun test tests/bg-tasks-fork-sdk.test.ts
bun run typecheck
```

The fork test defaults to a sibling `pi-mono` checkout and explicitly skips when
its tsx loader is absent. It uses synthetic sources, scrubbed child environment,
fake model responses, and actual provider serialization stopped at `onPayload`.
No provider transport, personal sources, or credentials are used. Two completions
share the existing tool-follow-up request: three initial model requests total,
one completion packet, no late wake. OpenAI Responses/Codex prefixes are exact
across follow-ups, ordinary turns, retry, and unchanged reload. Anthropic's native
moving `cache_control` markers are tested as an explicit exception; other content
is preserved. These checks are not measured live cache-hit rates or token savings.
