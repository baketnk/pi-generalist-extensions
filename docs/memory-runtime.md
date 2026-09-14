# Native Pi memory

The package's **only memory runtime** is `extensions/memory.ts`. It defaults off,
independent of personality. The former OptMem tool, wake/nap guidance, flags and
post-answer reminder have been removed. This does **not** delete an old archive,
import it, or silently activate the new store. Remove obsolete standalone
`optmem.ts` resource paths and `--optmem` launcher flags, then reload Pi. Other
already-running processes do not update themselves.

Requires Pi 0.85.1 and Node 24+ with `node:sqlite`/FTS5. It also works as a standalone
`pi -e /absolute/path/extensions/memory.ts` resource; do not load it twice alongside
the package. Ordinary recall/capture creates no extra model calls, automatic save reminders,
compression passes or shutdown notes. A separately configured, human-triggered
[housekeeping reviewer](#optional-housekeeping-model) can make one bounded model call.

## First use — human approval

1. Create a private directory **outside the repository** and initialize the native
   store explicitly:
   `bun tools/memory-admin.ts init /absolute/native-store --confirm init-native-memory`.
   Alternatively stage an approved inactive archive with the
   [offline importer](memory-migration.md). Never point native memory at the old
   OptMem directory.
2. In TUI/RPC, `/memory configure` asks for that initialized directory, an optional
   project UUID (`new` generates one; blank preserves an existing mapping or none),
   and a default personal UUID (`new` generates one; blank keeps the existing default
   or leaves it off). It shows the mapping and provider-disclosure warning for
   confirmation and **leaves memory off**. Use existing classification UUIDs when
   connecting migrated records. A personal-only setup needs no project mapping.
3. `/memory on` shows the store and selected scopes before enabling. The startup
   picker/settings controller can also enable an already configured store through
   an explicit human selection. Activation rebuilds the disposable index once;
   failure leaves the prior activation decision unchanged.
4. `/memory profile default` selects the opted-in default personal profile plus the
   mapped project, if any. In unmapped directories, personal recall still works.
   Without a default personal profile, default mode is project-only.
   `/memory profile project` explicitly excludes all personal memory;
   `/memory profile continuity UUID` chooses a specific configured personal profile
   instead of the default, alongside the project. Changing profile while on applies
   at the idle boundary; while off it stays off. Old explicit project-only decisions
   are preserved—use `profile default` to change them.

Configuration lives at `native-memory.json` under Pi's agent directory. Override
with `--memory-config /absolute/config.json`; the flag alone does not enable it.
No configuration/store is read during factory loading or ordinary off-state
prompts. Configuration contains an explicit store UUID/root, exact canonical-cwd
project aliases, personal UUIDs, an optional `defaultPersonalId`, optional
`preferMeitanMemory` picker preference, and up to 16 scoped pin IDs. Subdirectories are
**not** implicitly the same project. Multiple aliases must be explicitly added to
the private JSON config, or configured at each cwd with the same project UUID.

Config writes are bounded, private, locked, atomic and digest-checked. An enabled
branch binds the config digest, session ID, cwd and profile. External config edits
suspend access until reviewed activation again; they cannot silently add personal
scope. Config is local access policy, not canonical memory. Back it up separately;
portable store exports intentionally contain no local filesystem aliases or pins.

## Default personal memory and Meitan pairing

`/generalist personal` (or `/memory personal`) configures the default personal
identity with a disclosure confirmation. Blank UUID keeps the current default or
creates one; selecting an existing identity reuses its notes. Project-only default
removes the fallback without deleting notes or personal identities. Settings changes
leave memory off and select the default policy for the current branch.

The default personal profile is **global context, not global activation**. Once
configured, enabling memory can recall it from any directory, and selected notes
may go to the current provider. New/forked sessions still start off. Meitan alone,
including `/meitan on` and its CLI flag, never grants memory access.

`/generalist pairing` remembers whether the startup picker should offer Meitan+
memory first. It does not auto-select it, alter `/meitan`, schedule work, or enable
either feature. `/generalist companion` explicitly enables both Meitan and the
default memory profile in the current branch. These settings are also entries in
`/generalist`. The startup picker still requires a choice and retains its existing
launcher/reload/automation suppression rules.

Project matches rank ahead of personal matches, with a reserved personal candidate
when both match and the search limit exceeds one. Packet construction gives a
small personal item an early budget opportunity (at most one quarter of the packet
budget per eligible item), then displays selected project items first. This is
best-effort under existing pin/byte limits, not a guarantee every scope fits.
Scope labels and originals remain intact. Guidance tells the active model to use
relevant project-specific exceptions over conflicting personal defaults, while
keeping unrelated personal context. **No semantic conflict detector or automatic
merger exists**; current user instructions always win. New notes still require an
explicit scope, with active scope IDs supplied in the memory guidance.

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

- `/memory status`: branch request/effective state, effective scope IDs, default
  personal identity and last availability warning.
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

## Optional housekeeping model

The active conversational model authors `memory note/revise` calls; retrieval and
reindexing use local SQLite, not an LLM. Housekeeping is a **separate read-only
reviewer**, not an automatic saver or replacement for active-agent note authorship.

After `/memory configure`, open **Memory housekeeping model** in `/generalist`,
or use `/generalist housekeeping` (standalone: `/memory housekeeping`). Select an
available Pi provider/model and explicitly enable manual reviews. The exact
`housekeeping: { enabled, provider, model }` selection persists in native-memory.json.
Absent means off. There is no default, active-model fallback, or automatic schedule.
Selecting a lighter/local model does not change the conversation model. Changing
settings turns recall off; `/memory on` reviews the new configuration again.

Use `/memory review` to find candidate IDs, then `/memory housekeep ID [ID…]`:

- One to eight explicitly selected records, at most 24 KiB total. Current project
  and explicitly selected personal scopes only, plus the unassigned review inbox.
  Unassigned can contain mixed private data; every run shows the exact selected
  payload and destination model for human confirmation, even when recall is off.
- Only titles, bodies and classification metadata are sent. No conversation,
  system/personality context, retained source excerpts, tool access or whole-store scan.
- One completion, requested reasoning off, at most 2,048 output tokens/8 KiB text,
  with a 60-second deadline. No extension retries. Provider transport retries and
  model-specific thinking behavior remain provider-controlled.
- Escape in TUI or `/memory housekeep-cancel` cancels waiting; off, branch navigation,
  shutdown/reload also abort. Config/source changes suppress stale results. A provider
  ignoring abort may continue remotely; cancellation cannot retract disclosed text.
- Suggestions appear in a temporary editor for human inspection. Edits to that
  editor are ignored. Nothing is accepted, rewritten, classified, deleted, persisted
  as a report, or injected into the active agent. Sources remain authoritative.
- Successful runs append only provider/model, record IDs/revisions and usage metadata
  to a custom audit entry. This usage is **not** included in Pi's built-in session
  totals. Failed/cancelled requests may still incur provider charges.

Model/auth failures do not fall back to the active agent. Configure authentication
through Pi's normal provider settings; the memory config contains no credentials.
Tests use mocked completions, not real provider calls or a live quality evaluation.

## Prompt and lifecycle contract

Automatic recall uses only the current prompt's bounded lexical query and approved
pins, not an archive-wide summarizer or background worker. Selection happens once
at `before_agent_start`. A complete packet is at most 8 KiB, including framing
headroom, and at most one-eighth of the model context window measured
conservatively in **bytes**. Known usage additionally reserves output/context
headroom. Unknown/small context allowance disables automatic selection. These
caps are not a tokenizer or a guarantee against overflow from other content.

Each provider-context turn rechecks config/profile and retained-source access.
New selections also require a current source generation and sufficient allowance.
Already-sent snapshots retain their exact bytes and original message boundaries:
ordinary user turns, tool writes/results, retries, smaller budgets and model changes
must not evict them. Changed selections append a new snapshot; unchanged selections
are not repeated just because the packet UUID, timestamp or store generation changed.
An empty new selection can supersede the current selection without erasing history.
No summary becomes source evidence or activation authority.

Packets are projected into the provider-bound message copy from durable custom
snapshot entries, never persisted as LLM messages. The exact audit and boundary
snapshot must be saved before a new packet is injected. `/memory context`
reports what this hook prepared, **not** proof a remote provider received it or
that a later extension did not change the payload. Owned projections are stripped
from each incoming copy and rematerialized at their saved boundaries, not moved
to the latest user message. Ordinary accepted revisions remain historical. Purge,
retraction, revoked configuration/profile access, missing/replaced stores or an
unrecognizable context prefix retire the projection with a durable reset. This
deliberately breaks the prefix to stop further disclosure; past requests and audits
are not erased. Committed compaction and explicit activation changes start new
epochs. A compaction retry notification without a committed compaction is not a reset.

Reload/resume/tree reconstruct branch policy and replay authorized, anchored
snapshots byte-for-byte. Legacy audits have no saved boundary and are never
guessed back into history. Fresh prompts may append new selections. New/forked
sessions have no activation grant even if
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
through either an opted-in default personal profile or an explicitly selected
continuity profile.

The [index contract](memory-index.md) covers purge invalidation and stale readers.
A missing/corrupt/stale index suppresses new automatic recall with a UI warning;
already-sent snapshots remain if their retained sources are still authorized.
No prompt-triggered rebuild or paid fallback occurs.
Synchronous filesystem/SQLite work has no preemptible wall-clock deadline.
Canonical snapshots are still capped at 16 MiB/8,192 revisions; refusal never
prunes originals. This is bounded foreground memory, not an unlimited archive.

Validation uses synthetic stores and real Pi `SessionManager` branches. A separate
Node subprocess loads the extension through Pi's real loader and runs a scripted
agent loop with network disabled: it verifies automatic projection, a host-bound
capture, prefix preservation after writing, and off on the next request. Actual
serialized public-Responses and native-Codex request tests also verify fixed packet
boundaries, stable instructions/tools and unchanged history through ordinary turns,
tool results, retries and reloads. No private
archive or live model is used. Mocked lifecycle tests additionally cover
compaction retry, reload/tree/fork, scoping, malformed config, queued cancellation,
CAS, review, pins and budgets. These are not a full manual TUI/RPC cutover test.

The local OptMem archive was first staged into unassigned candidates. The user
subsequently approved its originals as legitimate personal memory: originals are
accepted in the default personal profile, and summaries remain classified artifacts
excluded from recall. Original revisions and source files are preserved. No model
calls or session activation accompany this offline approval. Private migration
manifests, before/after exports and verification reports stay outside this repository.
