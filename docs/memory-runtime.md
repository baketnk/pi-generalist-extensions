# Native Pi memory

The package's **only memory runtime** is `extensions/memory.ts`. It defaults off,
independent of personality. The former OptMem tool, wake/nap guidance, flags and
post-answer reminder have been removed. This does **not** delete an old archive,
import it, or silently activate the new store. Remove obsolete standalone
`optmem.ts` resource paths and `--optmem` launcher flags, then reload Pi. Other
already-running processes do not update themselves.

Requires Pi 0.85.1 and Node 24+ with `node:sqlite`/FTS5. It also works as a standalone
`pi -e /absolute/path/extensions/memory.ts` resource; do not load it twice alongside
the package. No network/model call, timer, worker, automatic save reminder,
compression pass or shutdown note is created by this extension.

## First use — human approval

1. Create a private directory **outside the repository** and initialize the native
   store explicitly:
   `bun tools/memory-admin.ts init /absolute/native-store --confirm init-native-memory`.
   Alternatively stage an approved inactive archive with the
   [offline importer](memory-migration.md). Never point native memory at the old
   OptMem directory.
2. In TUI/RPC, `/memory configure` asks for that initialized directory, a project
   UUID (blank generates one), and an optional personal-profile UUID. It shows
   the complete mapping for confirmation and **leaves memory off**. Use an
   existing classification UUID when connecting migrated records.
3. `/memory on` shows the store and selected scopes before enabling. The startup
   picker/settings controller can also enable an already configured store through
   an explicit human selection. Activation rebuilds the disposable index once;
   failure leaves the prior activation decision unchanged.
4. Project-only recall is the default. `/memory profile continuity UUID` explicitly
   adds that configured personal profile, alongside the current project if mapped.
   `/memory profile project` removes personal scope. Changing profile while on
   applies immediately at the idle command boundary; while off it stays off.

Configuration lives at `native-memory.json` under Pi's agent directory. Override
with `--memory-config /absolute/config.json`; the flag alone does not enable it.
No configuration/store is read during factory loading or ordinary off-state
prompts. Configuration contains an explicit store UUID/root, exact canonical-cwd
project aliases, personal UUIDs, and up to 16 scoped pin IDs. Subdirectories are
**not** implicitly the same project. Multiple aliases must be explicitly added to
the private JSON config, or configured at each cwd with the same project UUID.

Config writes are bounded, private, locked, atomic and digest-checked. An enabled
branch binds the config digest, session ID, cwd and profile. External config edits
suspend access until reviewed activation again; they cannot silently add personal
scope. Config is local access policy, not canonical memory. Back it up separately;
portable store exports intentionally contain no local filesystem aliases or pins.

## Tool and human controls

The model-visible `memory` tool is enabled only with an approved branch policy:

- `recall(query)`: scoped indexed lexical search, at most 8 KiB JSON with omitted
  count; no automatic full-store scan/rebuild. Empty/stopword queries return none.
- `read(id)`: latest accepted original in the selected scopes, at most 48 KiB
  complete JSON. Candidates, artifacts, other projects and unselected personal
  profiles are excluded.
- `sources`: metadata for the last ten nonempty user/assistant text messages in
  the current branch (entry IDs, authors, timestamps, byte counts), not bulk text.
- `note(scope, kind, title, body)`: bounded assistant-authored fact, reflection or
  thread. Explicit inferences and facts without sources enter candidate review;
  other authored notes may be accepted. Saving nothing is valid.
- `revise(id, expectedRevision, title, body, reason)`: revision-checked native
  assistant record correction, not imported/human-authored/pinned record editing.
  A fact correction without a new retained source returns to candidate review.
- `threads`: bounded open-thread cues, never authority to resume or schedule work.

`sourceEntryId` and `excerpt` must appear together and match actual current-branch
user/assistant text (text blocks joined with newlines). Excerpts are at most 4 KiB;
thinking, images, tool results, custom entries, branch/compaction summaries and
arbitrary filesystem paths are not eligible. The runtime obtains capture session,
assistant entry, tool call, provider/model and source entry origin from the host,
not model-supplied provenance. Source-backed means **exact retained bytes**, not
proof of the new note's interpretation or entailment. Library imports/callers can
still declare provenance themselves: this is not a cryptographic authenticity
claim or a semantic truth checker.

Writes queue the complete mutation window with Pi's file-mutation queue, then
recheck off/session/config state and cancellation. Canonical CAS/operation IDs
handle conflicts and identical tool-call retries. After committing, the tool
explicitly refreshes the index. If that fails, it reports **committed, index
unavailable**; do not repeat the write. Use `/memory reindex`.

Human commands (never model tool actions):

- `/memory status`: branch request/effective state and last availability warning.
- `/memory context`: exact last packet prepared by this hook, request ID,
  generation and selection reasons; identifies whether one is currently selected.
- `/memory review [offset]`: bounded candidate metadata, including unassigned inbox.
- `/memory show ID`: inspect a selected-scope or unassigned original, including its
  revision/source metadata, without adding it to model context.
- `/memory accept ID REV`: show the current scoped candidate for confirmation.
  Artifacts cannot become facts. Classify unassigned imports first with the CLI.
- `/memory pin ID`, `/memory unpin ID`: confirmed scoped selection changes; leave
  memory off afterward so `/memory on` reviews the changed config. Pinning does not
  promote or summarize a record. Oversized pins are omitted with `pinOverflow`.
- `/memory reindex`: explicit maintenance after external imports/review/correction.
- `/memory off`: stops new lookups/captures and discards the current packet without
  waiting for the agent to settle. It also invalidates already-queued native writes.

Classification, confirmed purge, export/restore and archive import remain explicit
[offline maintenance](memory-migration.md), not model actions. Human edits to
canonical data must use the validated store API with expected revisions; never
rewrite records in place. Unpin an assistant note before requesting an ordinary
model revision, or use human maintenance for protected originals.

## Prompt and lifecycle contract

Automatic recall uses only the current prompt's bounded lexical query and approved
pins, not an archive-wide summarizer or background worker. Selection happens once
at `before_agent_start`. A complete packet is at most 8 KiB, including framing
headroom, and at most one-eighth of the model context window measured
conservatively in **bytes**. Known usage additionally reserves output/context
headroom. Unknown/small context allowance disables automatic selection. These
caps are not a tokenizer or a guarantee against overflow from other content.

Each provider-context turn rechecks the config/profile, current request, source
file generation and remaining allowance. Stale packets are dropped, not silently
reselected mid-request. The exact packet is frozen (including timestamp) through
internal compaction retries; manual/threshold compaction and model changes clear
it. No summary becomes source evidence or activation authority.

The packet is projected into the provider-bound message copy at a stable user
anchor, never persisted as an LLM message. An exact custom-entry audit is appended
once before projection; if that fails, nothing is injected. `/memory context`
reports what this hook prepared, **not** proof a remote provider received it or
that a later extension did not change the payload. Previously projected owned
packets are stripped from each copy before inserting at most one current packet.

Reload/resume/tree reconstruct branch policy but do not replay an old packet.
Fresh prompts select anew. New/forked sessions have no activation grant even if
they inherit audit entries. Print/JSON can restore a previously approved session
but cannot create a fresh activation grant. Subagents are instructed not to use
memory; a fresh/forked session starts off. Passing an already approved session
verbatim to an untrusted subprocess is not a supported isolation boundary.

## Privacy, failures and review gate

Memory off is not amnesia or a filesystem sandbox. Old tool results, model answers,
source excerpts, exact packet audits, exports and backups remain outside its
removal boundary. Ordinary shell/read tools still have the user's filesystem
permissions. Use a new session to avoid historical influence. The configured
provider receives selected memory when enabled, including personal memory only
in an explicitly selected continuity profile.

The [index contract](memory-index.md) covers purge invalidation and stale readers.
A missing/corrupt/stale index suppresses automatic recall with a UI warning and
leaves conversation usable. No prompt-triggered rebuild or paid fallback occurs.
Synchronous filesystem/SQLite work has no preemptible wall-clock deadline.
Canonical snapshots are still capped at 16 MiB/8,192 revisions; refusal never
prunes originals. This is bounded foreground memory, not an unlimited archive.

Validation uses synthetic stores and real Pi `SessionManager` branches. A separate
Node subprocess loads the extension through Pi's real loader and runs a scripted
agent loop with network disabled: it verifies automatic projection, a host-bound
capture, invalidation after writing, and off on the next request. No private
archive or live model is used. Mocked lifecycle tests additionally cover
compaction retry, reload/tree/fork, scoping, malformed config, queued cancellation,
CAS, review, pins and budgets. These are not a full manual TUI/RPC cutover test.

Before live use: review the chosen inactive snapshot, real store path, project and
personal UUIDs, candidate classifications and provider disclosure. The original
OptMem files remain untouched for rollback. **No live import or activation was
performed by implementing this extension.**
