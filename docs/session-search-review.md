# Session-search fit review — 2026-09-13

User asked for research, not installation or implementation. Reviewed npm metadata,
README files and selected source from published tarballs, downloaded inertly under
`/tmp/pi-session-search-review/`. No package code executed, dependencies installed,
embeddings generated or transcripts sent to third parties. This is a fit review,
not a complete security audit or runtime compatibility test.

## Our needs

- Agent-callable search and bounded drill-down, not only a TUI session switcher.
- Explicit multiple source roots: global Pi histories plus Kouseki's
  `saves/vr-workspace/pi-agents/` (16 JSONL files at inspection).
- Session ID, entry ID, source path, cwd, role and time in citations; distinguish
  historical claims from live process state or verified artifact contents.
- Local lexical retrieval initially; no extra inference, embeddings, automatic
  context injection, agent launches, messaging, or competing durable-memory store.
- Avoid flattening alternate branches into a fictitious linear conversation.
- Bound text by bytes as well as entry count; no thinking/images by default;
  opt-in bounded tool evidence for checking reported results.

## Candidates

### samfoy/pi-session-search — npm pi-session-search 1.4.3 (MIT)

https://github.com/samfoy/pi-session-search

Closest existing functional match: `session_search`, `session_list`, paginated
`session_read`, local Node SQLite FTS5, optional embeddings. Source supports
`extraSessionDirs` and `primer.enabled=false`, despite the README emphasizing
standard global roots. Can disable periodic/startup sync through configuration.
Node 24+ requirement is met by local Node 25.2.1.

Caveats seen in source: `src/parser.ts` caps searchable assistant text at 50,000
characters per session, so later completion reports in long sessions may not be
indexed. Parser/reader iterate all file entries without branch reconstruction.
`src/reader.ts` limits entry count and individual tool output, but does not impose
a total byte cap on user/assistant prose. `session_read` uses lexical path-root
checks, not realpath containment, and its allowed roots omit the explicit
`sessionDir`/`archiveDir` overrides (extra roots are included). These are reasons
for a focused adaptation/review, not a claim that the package is unusable.

### felores/pi-session-search — npm @felores/pi-session-search 0.1.0 (MIT)

https://github.com/felores/pi-session-search

Closest philosophy: local, read-only transcripts, bounded snippets (50 KiB total),
explicit untrusted-history labels, no automatic memory/context injection or model
calls. Good separation from OptMem. Uses native `better-sqlite3`.

Current published peers require Pi >=0.84.3 <0.85.0, excluding installed 0.85.1.
`src/sources/pi-source.ts` takes one root and flattens file entries; no paginated
session-read tool, tool-result evidence excluded. Would need multi-root support,
provenance-aware drill-down and a compatibility update for our use.

### thurstonsand/pi-sessions — npm pi-sessions 0.12.1 (MIT)

https://github.com/thurstonsand/pi-sessions

Rich search filters, entry-level chunks, file evidence, session Q&A, handoffs,
messaging, subagents and automatic titling. Current peer range includes our Pi.
Every feature enabled by default; namespaces allow opt-out. Too broad for this
request without deliberate configuration. Auto-titling/Q&A entail model calls;
handoffs/messaging can start agents.

`extensions/session-search/reindex.ts` uses `SessionManager.listAll()` without
custom roots. Installed Pi's implementation scans the standard sessions tree;
this misses the existing external Kouseki root. Live hooks can index the current
custom-path session, but that is not equivalent to backfilling its siblings.
Extraction tracks lineage but search chunks still scan every file entry, rather
than selecting a single branch. Could adapt, but imports span a larger suite.

### pungggi/pi-session-finder — npm pi-session-finder 0.5.6 (MIT)

https://github.com/pungggi/pi-session-finder

Useful human `/find` and `/find-back` navigation. Uses `SessionManager.listAll()`;
no agent search/read tool and no custom-root backfill in the inspected flow.
Not a substitute for answering cross-agent questions in the current conversation.

### kaiserlich-dev/pi-session-search — 1.1.3 (MIT)

https://github.com/kaiserlich-dev/pi-session-search

Primarily overlay search/resume, native SQLite dependency, optional OpenRouter
summarization. Published peers still use the old @mariozechner package namespace.
Less aligned than the above; not pursued beyond README/metadata inspection.

## Recommendation

Do not choose an arbitrary extension: retrieval itself is commodity, but discovery,
branch/provenance handling, output limits and side-effect defaults matter here.
For fastest adoption, adapt samfoy's standalone package with embeddings and primer
off, add the Kouseki root, and fix bounded reads / long-session indexing first.
For our generalist extension collection, a small custom read-only search/read pair
is justified and preferable to adopting an orchestration/memory suite. Borrow
existing MIT-licensed patterns with attribution rather than invent a search engine.
Start lexical, with configured roots and no watchers/model calls; add an incremental
SQLite index only as measurements justify. Validate on disposable branch/partial
JSONL/large-output/path fixtures plus authorized known-session queries before calling
it better. No implementation or package installation was authorized in this review.
