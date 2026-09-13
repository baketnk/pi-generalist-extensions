# Execution receipts

Implemented for **new `bg_tasks` jobs on Linux**. Ordinary `bash`, historical
commands, evidence-shelf entries, and existing job records are not retroactively
converted. No model calls, services, package installs, or automatic reruns.

## Cache boundary

Receipt capture does not change the `bg_tasks` tool schema, description, prompt
snippet, or guidelines. It adds no context/system-prompt/provider hooks, startup
injection, dynamic tool activation, or rewriting of old messages. The existing
completion message format and notification preferences are unchanged.

Receipt references are persisted using Pi **custom entries**, which do not enter
LLM context. An explicit `bg_tasks status` response includes the receipt path and
SHA-256; this is a new tool-result tail, not a mutation of the cached prefix.
Reload/resume does not replay receipts into model context or adopt old jobs.

`tests/execution-receipt-cache.test.ts` pins the pre-receipt tool-contract hash and
checks byte-identical LLM message projection through real SessionManager
persistence/reopen. This is a local regression check, not a live provider cache-hit
measurement or a guarantee about unrelated extensions/provider eviction.

## Capture and storage

The existing private job directory under `<Pi agent dir>/bg-tasks/<owner>/<job>/`
now contains `receipt.json` alongside `launch.json`, `state.json`, `result.json`,
and `output.log`. The Pi agent-directory override is respected by the adapter.

The versioned receipt records:

- Origin `bg_tasks`, runtime owner, job ID, exact command, shell executable/arguments,
  canonical cwd, timing, configured limits, and notification preference.
- Actual exit code/signal, stop reason, launch/write errors where available, and
  cleanup state. Cancellation may coexist with exit zero; exit zero is not a
  model-authored assertion that tests passed.
- Best-effort **pre-launch** Git root, HEAD (when available), and
  clean/dirty/unknown working-tree state.
- Raw combined log byte length and SHA-256, or explicit missing/unavailable state;
  capture closure (`closed`, `forced_close`, or `write_error`) and truncation facts.

The runtime waits for stdout/stderr closure after leader exit. After one second,
inherited open pipes are forcibly closed and capture is labelled `forced_close`,
with cleanup `unknown`. Pending log writes settle before hashing/publication;
the runtime does not append after receipt capture. This is not proof that all
descendants terminated. Lost live logs are not silently recreated.

`launch.json`, `result.json`, and `receipt.json` use private same-directory staging,
file fsync, and no-clobber hard-link publication. Each is published once;
`state.json` remains replaceable. These files are **not a multi-file transaction**,
tamper-proof, or guaranteed power-loss durable (no directory fsync). A late failure
can leave a receipt without a result; live status reports persistence errors and
does not pretend the missing metadata was written. A crash without a receipt is
unknown, not evidence of success. Existing records are never rewritten/migrated.

## Source and privacy limitations

Git probes are local argv-based commands, each limited to two seconds and 256 KiB
of output. No fetching, staging, diff retention, or checkout snapshots. Optional
index writes and fsmonitor are disabled; inherited `GIT_*` redirection is removed
for these probes, not for the user's command. Failures, absent Git, non-worktrees,
or oversized status output yield unavailable/unknown information, never clean.
An unborn repository can have no HEAD.

The probes are **not an atomic source snapshot**. Dirty includes tracked/untracked
changes visible to Git, including submodule status. Ignored files, ignored
dependencies, external services, environment, and edits during/after launch are
not identified. A command can execute somewhere other than its launch cwd; the
source observation describes that cwd's worktree only. No automatic current-validity
verdict follows later source changes.

No complete environment, file-name list, source content, or personal context is
stored. The exact command and raw logs can themselves contain secrets; receipts
and logs stay local and require explicit sharing. There is no automatic retention
sweep or receipt index. Parent-path races/noncooperating writers remain outside
the guarantee; this is local bookkeeping, not a filesystem sandbox.

## Explicit inspection

For a current job, use `bg_tasks status` or `/bg-tasks status JOB_ID` to obtain the
receipt path and hash. Saved session custom entries retain the reference after
reload; ordinary file reads can also inspect the JSON directly.

From this package directory:

```sh
bun tools/execution-receipt.ts read /absolute/path/receipt.json
bun tools/execution-receipt.ts check /absolute/path/receipt.json EXPECTED_SHA256
```

`check` reads only the sibling `output.log`, never arbitrary paths embedded in
JSON. It reports receipt-byte integrity separately from artifact integrity. Omit
the expected receipt hash to compare just the log against the loaded receipt;
receipt integrity then says `not_checked`. A match means byte agreement with the
supplied record, not provenance authenticity or correctness of the program.

Checks never rewrite receipts, re-run jobs, or update source observations. Missing
receipts throw; missing, changed, oversized, or unsupported logs are explicit.
The CLI exits nonzero for a failed check. A matching log can still be a truncated
or forced-close capture—inspect those receipt fields separately.

Reads are bounded to 256 KiB of receipt JSON and 64 MiB of log data; log hashing uses
64 KiB buffers. Final symlinks and non-regular files are rejected. Verification is
point-in-time and detects some concurrent changes, not filesystem compare-and-swap.

## Validation scope

Fixture/local-process tests cover drained large/binary output, silent commands,
nonzero exit, timeout, cancellation/shutdown, inherited pipes, Git clean/dirty and
untracked state, publication conflicts, write loss, changed/missing/symlink
artifacts, bounded receipt reads, and cache-boundary/session-reopen behavior.
Native Windows/macOS, live provider cache accounting, host power loss, and full
process containment are not covered by this implementation.
