# Local cross-harness history search

Two on-demand Pi tools, independent of Meitan and OptMem:

- `history_search`: SQLite FTS5 search, optional variants, harness/cwd/date/role
  filters, or recent-message browsing with an empty query. Quotes make phrases;
  unquoted terms are ANDed within a message chunk; variants are ORed. Returns at
  most 20 messages, deduplicating chunks of a message. The 200-candidate retrieval
  bound may return fewer results when one long message dominates matches.
- `history_read`: use the opaque `session` key from a search result, optionally
  its `entry` ID. Returns the newest window in chronological order. `nextOffset`
  walks backward without skipping messages. `includeTools` reads tool evidence
  from original sources; tool payloads are never in the search index.

`/history-index` refreshes; `/history-index status` shows counts and sizes. Node
24+ provides `node:sqlite`/FTS5, with no added runtime dependency. Standalone CLI:

```sh
node tools/history.ts refresh
node tools/history.ts status
node tools/history.ts search 'Parakeet benchmark'
node tools/history.ts read SESSION_KEY ENTRY_ID
```

## Configuration and privacy

Default source roots are Pi's agent sessions directory, `~/.omp/agent/sessions`,
`~/.codex/sessions`, `~/.codex/archived_sessions`, and `~/.hermes/state.db`.
Missing sources are reported, not created. Hermes JSON transcript exports are
not also indexed, avoiding a second representation of the same conversations.
No source root is inferred from project-local instructions or a transcript.

Override with `~/.pi/agent/history-search.json`, or an explicit `PI_HISTORY_CONFIG`
file. `PI_CODING_AGENT_DIR` relocates the default config/index and Pi session root.
The file replaces the complete source list; all paths must be absolute:

```json
{
  "version": 1,
  "indexDir": "/home/you/.pi/agent/history-search",
  "sources": [
    {"harness": "pi", "path": "/home/you/.pi/agent/sessions"},
    {"harness": "pi", "path": "/workspace/kouseki_engine/saves/vr-workspace/pi-agents"},
    {"harness": "omp", "path": "/home/you/.omp/agent/sessions"},
    {"harness": "codex", "path": "/home/you/.codex/sessions"},
    {"harness": "hermes", "path": "/home/you/.hermes/state.db"}
  ]
}
```

Explicit roots may be symlink aliases, canonicalized at discovery; nested
symlinks are not followed. Files outside current configured roots cannot be
read through tool session keys, even if an old index still lists them. The index
directory/database use owner-only modes. Transcript prose itself may contain
private information or pasted secrets: this is **not secret redaction**. Search
results go to the current agent/model just like any read tool output. There are
no separate network, embedding or summarization calls.

The tools register without indexing, timers, watchers, subprocesses or injected
history. First search refreshes by default; subsequent refreshes reparse only
changed files, based on device/inode/size/mtime/ctime (and SQLite WAL metadata).
This is changed-file incremental indexing, not an append-offset optimization.
Hermes is one source file and its changed snapshot is reindexed as a unit.
`refresh: false` searches the existing index immediately, without discovery.
Results include index timestamp, source warnings and whether the source changed.
There are no source mutations, source-schema migrations, memory saves or session
switches. Hermes is opened read-only with a query-only read transaction.

## Representation and limitations

Search stores user/visible-assistant prose and **labeled summaries**, excluding
thinking/reasoning blocks, images, system/developer prompts, custom extension
messages, tool calls and tool results. Pi/OMP preserve native message IDs and
parent links on reads. Codex indexes canonical `response_item` messages, not
repeated display events; line locators distinguish entries without native IDs.
Hermes indexes active user/assistant messages, labels `_compressed_summary`, and
excludes separate reasoning fields. Historical schema variants beyond the tested
ones may need an adapter update; unknown/malformed input is reported rather than
claimed as fully indexed.

Search spans recorded branches; it does not claim the currently selected/live
branch. Pi/OMP reads follow ancestry ending at the requested entry, or the latest
recorded entry. Non-prose nodes are retained for ancestry. A missing ancestor is
reported, and cycles fail explicitly. For Codex/Hermes reads, an entry bounds the
linear history. Use an entry from another search match to inspect a different path.
Neither session recency nor an assistant's completion sentence proves a live
process state, successful test, deployed binary or physical acceptance.

Text is chunked at 4000 characters with 160-character overlap, including late
messages in long sessions. Ordinary SQLite tables contain the text; an
external-content FTS5 table avoids storing another full text copy inside FTS.
JSONL files larger than 512 MiB are refused; lines over 16 MiB are skipped
and reported. A malformed final JSONL line can be a live partial write. Indexing
publishes each source transactionally only if its metadata stayed stable during
parsing; changing/failed sources preserve previous results with freshness warnings.
Deleted or unconfigured sources are removed on refresh. SQLite WAL and a busy
timeout support simultaneous Pi readers/writers; one extension instance serializes
its own tool calls. Index errors propagate or appear in refresh diagnostics,
never trigger source repair.

Output is valid JSON under 48,000 bytes. Read messages are capped at 6000 characters
and flagged if truncated; source path and line/row citations remain available for
more detailed manual inspection. The byte budget can reduce a page below its
requested count while preserving its newest anchor and correct next offset.
The index is disposable: close users of it and remove the configured index directory
to rebuild. No cleanup or rebuild deletes source histories.

## Validation

`bun test` includes disposable Pi/OMP/Codex/Hermes fixtures, branch ancestry,
reasoning exclusion, tail search, malformed live lines, updates/deletions, source
allowlisting, Unicode byte bounds/pagination, cancellations, and extension wiring.
No fixture test accesses personal histories or model providers. Live-corpus
measurements, when run, are recorded separately below rather than asserted from
package marketing benchmarks.

### Local corpus measurement — 2026-09-13

Node 25.2.1 on the user's Linux workstation, configured with global Pi, Kouseki Pi,
OMP, Codex and Hermes SQLite sources. Initial refresh: 519 sources / 1,464 sessions,
18,611 chunks, 33,509,008 bytes of searchable chunk text (~32 MiB), no failed sources
or discovery warnings. Database after close/checkpoint: 57,827,328 bytes (**55 MiB**).
The initial open connection also had ~23 MiB of transient WAL, not another permanent
transcript copy. Indexing took 8,483 ms. One subsequent changed-file refresh took
52 ms (one updated source, 518 unchanged).

Eighty searches (ten repeats each of Parakeet, small.en, OptMem, Box3D, SteamVR,
Duckpole, foot locking, pinball) measured **1.32 ms median / 6.03 ms p95 / 6.41 ms
maximum**, including result formatting and source freshness checks in `search()`.
These are warm local measurements after indexing, not cold-storage or isolated-load
benchmarks. Search/read citation round-trips succeeded for all four harnesses,
without printing private excerpts into the public report. This is integration
coverage, not a scored retrieval-quality benchmark.

No cron is installed: normal search refreshes changed files on demand. If needed,
a user-scheduled `node tools/history.ts refresh` can run without a model or agent.
The fixture suite and TypeScript checks are the maintained regression gate.
