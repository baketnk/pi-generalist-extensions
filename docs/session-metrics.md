# Session metrics

Read-only local report for the Code Mode evaluation track in [the roadmap](ROADMAP.md#1a-sandboxed-tool-orchestration--code-mode).

```sh
bun tools/session-metrics.ts /absolute/path/session.jsonl
# From a Pi shell tool, explicitly select its current session:
bun tools/session-metrics.ts "$PI_SESSION_FILE"
```

Counts persisted assistant responses, outer tool-call blocks, outer `exec` calls,
and unique nested calls from paired `pi.nested-tool.v1` custom start/end records.
Nested calls are keyed by parent and child IDs, not guessed from JavaScript text.
Starts without ends have unknown outcomes; orphan ends are counted and flagged.
Failures remain separate from success. Successful means only `isError: false`,
not correctness of the operation or a passing test suite. The nested density
uses distinct traced orchestrator parents, including orchestrators not named exec.

Scope is explicitly **the whole physical file, including all branches**, not the
active provider context. Compaction retained-tail copies, summaries, and extension
custom messages are not counted as new model responses. Error/aborted assistant
responses are counted separately as well as in the total. User-message counts
are not asserted to be human prompts: extensions can inject user messages.

These are recorded counts, not provider request/latency totals, cache-hit rates,
or proof of saved model turns. Retries with no persisted assistant response and
model calls made outside this transcript are not measurable here. No token/cost
summing, session discovery, source execution, model calls, or context injection.
No message text, tool arguments/results, paths, or IDs appear in the report.

Supports Pi session headers v2/v3. Reads at most the regular file size observed
on open: 64 MiB/file, 2 MiB/line, 100,000 split lines. Final symlinks and
non-regular files are rejected. It does not tail or rewrite the file, follow
parent-session links, or import sessions through a potentially migrating SDK.
This is not an atomic snapshot against concurrent rewriting.

An invalid unterminated final line is explicitly ignored and flagged (it may be
a live partial append or corruption); invalid complete lines, unsupported headers,
and malformed/duplicate/conflicting nested records fail with a nonzero CLI exit.
Input limits fail explicitly rather than silently reporting a partial history.
