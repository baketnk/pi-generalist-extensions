# Native recall index

The disposable local FTS5 index (`memory-recall-v1.sqlite` inside the explicitly
chosen native store) indexes **only latest accepted scoped notes**, never
unassigned candidates, retractions, superseded revisions or summary artifacts.
It is not canonical memory and is excluded from portable exports.

`rebuildRecallIndex(root, storeId)` is explicit maintenance. It holds the same
writer lock as canonical mutations, validates the complete snapshot, builds a
private temporary SQLite file, fsyncs it, and publishes by rename. No WAL,
provider, model, watcher or timer is involved. The source's full hash and stat
identity are recorded; the index is capped at 64 MiB.

`RecallIndex` opens the prepared database read-only for a short lookup. It checks
the canonical file's device/inode/size/nanosecond mtime/ctime before and after
lookup. A changed/missing source or index fails explicitly; it never falls back
to scanning/rebuilding the archive during a prompt. This checks ordinary file
changes, not hostile same-account manipulation or semantic truth. Rebuilding is
required after an external CLI import/correction; native tool writes may rebuild
explicitly at their execution boundary.

Queries use literal Unicode word tokens, not executable FTS syntax. Contraction
suffixes and common stopwords are removed; automatic queries additionally discard
conversational filler. Up to 32 distinct tokens are sampled across the whole bounded
4,096-character prompt, not just its first words. Latin accent folding is supported;
this is not a multilingual morphological analyzer. Punctuation splits identifiers
(`bg_tasks` -> `bg`, `tasks`); it does not distinguish C++ from C#. There is no fuzzy,
prefix, synonym, stemming or vector expansion. Manual recall remains an AND query
with a default limit of ten; automatic recall defaults to **at most three lexical
hits**, and returning **zero** is normal.

Candidate and title evidence comes from exact FTS postings, never substring
matches. Each exact approved scope has its own document count and term frequencies;
no global BM25 or unapproved-corpus statistics affect ranking. Per-term weight is
`1 + log(1 + (N - df + 0.5)/(df + 0.5))`; absent query terms contribute weight 1 to
the coverage denominator. Repeated words earn no extra credit. Automatic direct hits
need two distinct query terms (one for a single-term query), at least 35% weighted
query coverage, and a topic-bearing word: generic words such as `results`, `turn`,
`local` and `removed` cannot establish a topic alone. Score is covered weight plus a
20% title bonus, multiplied by coverage; date/ID only break ties. These are
conservative heuristics, not calibrated probabilities or semantic truth checks.

An apparent elliptical follow-up (`it`, `those`, `that`, etc.; at most eight query
terms and not generic-only) can receive up to eight extra topic tokens from **one
preceding user prompt** (first 1,024 characters, at most 64 branch entries inspected). The hook never uses
assistant/tool/custom-message prose, old recall packets, other branches or text
before a compaction/activation/projection-reset boundary. Explicit topic-switch
phrases disable the hint. A supported hit still needs a current-query match,
two topic-token matches, and 20% current-query coverage. Direct qualifying hits rank
before supported ones; topic score contribution is capped at 25% of current matched
weight. No recursive topic state or additional conversation text is injected.

Relevance gates run **before** project-first selection and the reserved personal
slot: weak personal hits do not force their way into a packet. Strong personal
matches retain an opportunity when both scopes qualify and the limit exceeds one.
Project-only queries never fetch personal postings. Duplicate scopes are deduplicated.
Pin IDs remain scope-bound and exempt from lexical thresholds and the three-hit
ceiling, subject to the existing packet/pin byte caps. Thus three lexical hits plus
pins can exceed three total records. An older explicitly pinned preference can
remain available without matching today's query. Open threads remain explicit cues,
never scheduled work.

The packet builder keeps whole original bodies or omits whole items. It caps the
complete JSON packet at 8 KiB, with framing headroom, at most 2 KiB of human pins
and 1 KiB of pinned open threads inside that allowance. Oversized pins report
`pinOverflow`, not silent truncation. Dates, authorship, record/source hashes,
selection reasons and a historical-data notice travel with the selected body.
For mixed scopes, one small personal item (serialized size <= one quarter of the
packet budget) gets an early budget opportunity after the first project item.
Final display is project-first. Existing pin/byte limits still apply, so both scopes
are not guaranteed to fit; originals are never merged or rewritten.
Byte caps are not token guarantees; the Pi adapter must additionally respect the
active model's context allowance. Other extensions/history still consume context.

Selection changes apply only to **new** packets. Existing packet bytes/boundaries,
tool definitions and system guidance are unchanged. An empty selection can append
an empty transition packet, but never deletes prior snapshots. Reload activates the
new algorithm; the index schema is unchanged, so no migration or reindex is needed
for an already-fresh index. No personal store/configuration is rewritten.

## Purge and invalidation

Every canonical publication removes the owned recall cache **before** replacing
the store. That includes retraction, purge, import and schema upgrades. Purge also
removes matching interrupted index-builder temporary files while holding the
shared lock, so no cooperating live builder owns them. Symlink/nonregular derived
files cause explicit refusal; they are never followed. Interrupted canonical
`.pending-*` files remain a separate manual-recovery limitation.

Already-open read handles in another process can temporarily retain unlinked
bytes, but generation checks prevent knowingly returning those as fresh memory.
Already sent packets, prior exports and external filesystem backups cannot be
recalled or securely erased. The index is not an encryption or process sandbox.
The manual housekeeping reviewer retains no persistent payload/report. It checks
selected records/configuration before showing results; already-sent requests and
already-displayed text cannot be recalled.

## Validation

`bun test tests/memory-relevance.test.ts` adds a 12-query synthetic relevance
benchmark (exact names, lexical paraphrases, follow-ups, and seven expected-empty
queries), plus rarity, repetition, substring collisions, scope isolation, pins,
Unicode and bounds. A maximum-corpus fixture exercises 8,192 tied records with
32 query terms, validates date/ID cutoff, and reports lookup latency. It reports
useful/returned hits and new packet bytes; this is not a live private-store evaluation or a guarantee of semantic relevance. Provider
payload regressions in `tests/memory-extension.test.ts` cover positive-to-empty
selection, repeated empty turns, contextual selection and reload as well as ordinary
user turns, tool writes/results, retries and smaller budgets.

`bun test tests/memory-index.test.ts` exercises scoped FTS, stale readers, explicit
maintenance, rejected sources, pins/budgets, thread status, cache deletion on purge
and import, corruption/symlinks, aborts, and non-mutating read-only lookup. Timings
are measured on local fixtures; no universal 100 ms deadline or remote-filesystem
latency guarantee is claimed. SQLite uses zero busy-wait for prompt lookup;
filesystem and synchronous query latency cannot be preempted by an async timeout.
