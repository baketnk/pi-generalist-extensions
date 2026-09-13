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

Queries use bounded Unicode word tokens, not executable FTS syntax. Common
stopwords are excluded. Manual searches AND the tokens; automatic selection ORs
them and ranks scope-filtered hits by matching title/body terms then date/ID.
No global-corpus ranking or network query expansion is used. Pin IDs are resolved
inside the same selected scopes. An older explicitly pinned preference can remain
available without matching today's query. Empty/stopword-only queries select no
unpinned notes. Open threads are available explicitly, never scheduled work.

The packet builder keeps whole original bodies or omits whole items. It caps the
complete JSON packet at 8 KiB, with framing headroom, at most 2 KiB of human pins
and 1 KiB of pinned open threads inside that allowance. Oversized pins report
`pinOverflow`, not silent truncation. Dates, authorship, record/source hashes,
selection reasons and a historical-data notice travel with the selected body.
Byte caps are not token guarantees; the Pi adapter must additionally respect the
active model's context allowance. Other extensions/history still consume context.

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
There are no worker payloads yet; adding them requires equivalent invalidation.

## Validation

`bun test tests/memory-index.test.ts` exercises scoped FTS, stale readers, explicit
maintenance, rejected sources, pins/budgets, thread status, cache deletion on purge
and import, corruption/symlinks, aborts, and non-mutating read-only lookup. Timings
are measured on local fixtures; no universal 100 ms deadline or remote-filesystem
latency guarantee is claimed. SQLite uses zero busy-wait for prompt lookup;
filesystem and synchronous query latency cannot be preempted by an async timeout.
