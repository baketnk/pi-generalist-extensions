# Pi switchboard — MVP

A shared project roster and durable mailboxes for parallel Pi sessions. The same
participant client supports explicitly provisioned headless workers. Switchboard
itself does not launch them; the separate [inspect-subagent runner](subagents.md)
owns execution. The broader [design](agent-coordination-proposal.md) still includes
future work and is not a list of implemented features.

## Start and opt out

After package installation, `/reload` or start Pi. On Linux, TUI sessions register
by default. The adapter starts a small per-user Node helper on demand; concurrent
starts are serialized with `flock`. No systemd installation, boot persistence,
provider calls or trace summarization. The helper outlives individual sessions and
exits after approximately five minutes without live attachments.

Requirements: **Node 24+** with native TypeScript stripping and `node:sqlite`, and
`flock` on PATH. Pi/Bun itself does not need to host SQLite. Normal Pi work proceeds
if registration fails; the footer says `peers: unavailable`. `/switchboard status`
shows the error and configured paths. Unadapted sessions remain invisible.

- `PI_SWITCHBOARD=off pi`: opt out before startup; no switchboard registration or
  storage initialization. This takes precedence over commands.
- `/switchboard off` / `on`: detach/reconnect this logical session; suppression is
  outside conversation branches and survives reload/resume/tree navigation.
- `/switchboard project-off` / `project-on`: change the local project enrollment
  preference. Other adapted sessions notice within their 15-second heartbeat
  interval. This is **cooperative policy, not credential revocation or a project ACL**.
- `/switchboard manual` / `auto`: remain observable, but suppress/restore automatic
  roster and inbox publications. If observations were already exposed, one inactive
  marker is appended; their historical copies remain in context/history.

New/forked/cloned sessions get a new binding, subject to the same project policy.
Unprovisioned print/JSON/RPC sessions do not register. A worker runner must explicitly
supply `PI_SWITCHBOARD_WORKER_FILE=/absolute/private/capability.json` containing its
own `{ "token": "..." }`, and include `switchboard` in its active tool allowlist.
Do not blindly inherit that file variable into nested workers or unrelated Pi runs.

## Everyday use

`/switchboard` opens a project roster/inbox selector. Details are a scrollable,
dismissible TUI overlay; no inference and no focus-stealing arrival notifications.
`/switchboard dashboard` (also `/generalist dashboard`) opens the live searchable
roster/inbox/offers desk. [Interactive task offers](switchboard-dashboard.md) have
separate human acceptance and Start controls; they are not executable mail kinds.
Footer: `peers: N · sub: N · mail: M`, hidden when there are no registered
participants or pending mail. `peers` counts other registered participants and
excludes this session's direct children; `sub` counts those direct registered
subagents. Neither count is verified useful progress or a process census.

Commands:

```text
/switchboard status
/switchboard mail
/switchboard mail 20
/switchboard read
/switchboard read m_ID
/switchboard ack m_ID
/switchboard send acorn-crown-jay-glow A narrow coordination question.
/switchboard reply m_ID My answer.
/reload-all
```

Newer-daemon detection on heartbeat/reconnect automatically queues a reload for
TUI sessions **once idle**, with no pending input or open extension prompt. Busy
agents defer until settled. A persisted attempt marker limits this to one automatic
attempt per daemon protocol version, preventing a reload loop if the installed
source is still old. Headless workers do not auto-reload. Manual observation mode
is independent; session/project opt-out still suppresses participation.

Clients never terminate a **newer** helper. A newer client can still replace an
older helper under the existing startup lock. All sessions predating this safeguard
need one manual `/reload` (including other projects sharing the per-user helper):
their already-loaded mismatch handler can otherwise repeatedly SIGTERM the newer
daemon. `/reload-all` remains useful as a manual fallback but can miss clients that
are disconnected during a restart loop.

`/reload-all` queues one reload for each *other* agent currently connected to the
switchboard and queues this session's reload locally. A receiving extension claims
the private queue item and programmatically enqueues its internal reload command as
a follow-up. It never interrupts an active run, adds no model-visible message, and
requires no tool call from the receiving agent. Offline, opted-out, or subsequently
disconnected sessions are not targets; a repeated command replaces an already-pending
reload rather than accumulating work.

These Pi commands correspond **as the current participant**, not as a new user-role
instruction. Human-only viewing does not expose mail bodies to the model or imply
acknowledgement. `ack` means noted/dismissed, not accepted or completed.

The stable `switchboard` tool is registered without adding dynamic system-prompt
text. Actions:

```json
{"action":"peers"}
{"action":"peers","all":true}
{"action":"inspect","id":"acorn-crown-jay-glow"}
{"action":"status","summary":"Reviewing capture tests; leaving settings alone."}
{"action":"send","recipient":"acorn-crown-jay-glow","kind":"question","body":"Are you changing the settings interface?"}
{"action":"inbox"}
{"action":"read"}
{"action":"read","id":"m_ID"}
{"action":"reply","id":"m_ID","body":"Yes; please leave that file to me."}
{"action":"ack","id":"m_ID"}
{"action":"delivery","id":"m_ID"}
{"action":"retry","operation":"op_ID_FROM_UNCERTAIN_SEND"}
{"action":"wait","seconds":60}
```

`peers` defaults to the canonical repository group, preserving worktree boundaries;
`all:true` explicitly broadens discovery. Tool listings show at most 16 peers; the
service/CLI show up to 64, with totals. `inspect` and `send` accept an exact `p_ID`
or a full generated handle. The examples use an illustrative handle; use one from
your actual roster. Summary is an explicit declaration, clipped to 480 UTF-8 bytes.
Pi session names remain optional task labels (160 bytes), followed automatically;
no automatic first-prompt extraction or renaming of the Pi session.

### Stable readable handles

Each participant has an immutable machine ID and a server-derived four-word handle,
for example `acorn-crown-jay-glow`. Rosters show the handle with any distinct task
label; unnamed sessions no longer show `unnamed · HASH`. Mail metadata and displays
also include sender/recipient handles while retaining canonical IDs for receipts,
replies and authorization.

The dependency-free v1 vocabulary has 256 unique short ASCII words. Four SHA-256
bytes, domain-separated and derived from the randomly generated participant ID,
select four words: **32 bits / 4,294,967,296 possible handles**. At the 1,000-participant
quota, the approximate birthday probability of any collision is 0.012%. These are
readable addresses, not secrets. The vocabulary ordering and derivation are frozen
and regression-tested; no database migration or extra model call is needed.
Existing IDs gain handles too. Handles survive renames, reload/resume and daemon
restart while the participant record is retained; a new/forked binding gets a new
ID and derived handle. Pruning/deleting the identity ends that guarantee.

Resolution happens inside the existing server request, across all retained,
unarchived identities, including offline and cross-project participants—not only
visible roster cards. Only exact case-sensitive handles match: no prefixes, fuzzy
matching, task-label lookup or live-peer preference. A collision rejects with IDs
to disambiguate. Changing a task label cannot impersonate somebody else's address.
Accepted-send retries return the original receipt before attempting resolution,
even if a collision appears or the recipient is later archived.

Protocol v5 adds recent-mail browsing, receipt-free peeking and heartbeat version
signaling; handles, ID-free reads and human offers remain (database schema v3). See the dashboard contract for upgrade and limits.
Reload all participating Pi sessions when updating; the existing helper upgrade
path restarts the old daemon on reconnect. Mixed old/new adapter versions are not
a supported steady state.

### Recent-mail browser

`/switchboard mail` (also **Recent mail** in `/switchboard`) lists this participant's
incoming mail: **all pending entries** (up to the 128-message mailbox quota), then
the latest **50 acknowledged or expired entries**. `/switchboard mail N` selects
0–100 recent entries without reducing the pending list. Pending mail is oldest
first; recent mail is newest acknowledgement/expiry first, with stable ID ties.
This is not a cross-agent admin browser or a sent-mail archive.

Labels distinguish unread, fetched-but-pending, acknowledged and expired mail.
Select an entry to peek, dismiss its detail to return to the list, or choose Refresh.
Listing is metadata-only. Peeking does **not** mark fetched, acknowledge, copy into
Pi history or call a model. Existing `/switchboard read` still marks fetched.
Bodies obey existing expiry/24h-after-ack limits; unavailable bodies display as
expired/pruned. Recent metadata still ages out after 14 days. The count is a view
limit, not an extension of retention or a promise of indefinite unread storage.

### Reading without a message ID

`{"action":"read"}`, `/switchboard read`, and CLI `read` return one oldest pending
(unacknowledged, unexpired) incoming message, ordered by creation time then ID.
They mark it fetched but **do not acknowledge it**. Repeated ID-free reads return
that same message until explicit `ack` or expiry; this is not an advancing cursor.
The response includes its ID for `ack`/`reply`, and an empty mailbox returns
`{ "empty": true, "note": "No pending messages." }` without error. Explicit-ID reads
still work for any mail accessible to this participant. Automatic observations
remain metadata-only; no bodies are exposed merely by listing the inbox.

### Wait semantics

`wait` waits for **mail**, not a process. Default 60 seconds, maximum 300. It yields
a tool result for addressed pending mail, user input, timeout, or service loss.
Esc aborts the wait through Pi's tool signal; session shutdown cleans up listeners.
It also checks Pi's queued-input state so early input cannot be lost before the wait
listener is installed. It does not trigger a new request outside the existing agent
run. Ordinary tool-result continuation can still make another model request.

Already-pending unacknowledged mail returns immediately. Read/ack handled mail
before waiting again; don't create a tight wait/read loop. The timeout can be used
for an **explicitly requested** occasional check, but it isn't a scheduler or an
automatic polling loop. The process runner's future wait/auto-wait/output-check
contract is separate. Existing `bg_tasks` completion behavior is unchanged.

## Automatic awareness and privacy

When relevant peers or new mail exist, the adapter publishes a small observation
at an existing model boundary, including normal continuation after tool results.
No `sendUserMessage`, steering, automatic greeting/reply, inference wake, or model
call to update names/status. Adapter HTTP long-poll subscriptions are not model
polling. The `context` hook uses cached state, never daemon I/O.

- Roster: up to eight peers within a 2,000-byte card budget, plus bounded framing;
  parent/sibling/own-worker relationships and same-checkout peers rank first.
- Meaningful roster changes coalesce to at most once/minute during a run. Heartbeat
  timestamps and busy/idle chatter do not churn model context.
- Mail hints: up to five IDs/sender IDs and handles/kinds per existing request; never body previews.
  Newly arriving addressed mail can bypass the roster debounce so a wait can yield
  promptly. Per-sender and mailbox quotas still bound pending mail.
- An empty project adds no automatic context. Losing previously observed peers or
  service access produces an honest update, not a claim of exclusive access.

Publications are journalled as custom entries and projected at stable message
boundaries; old observations are not moved or rewritten. Tests cover converted
provider-message prefixes, not measured provider cache hit rates. Compaction can
restore the current roster once; external hint bookkeeping prevents old mail from
becoming a fresh request simply because the branch/compaction changed. Retries and
reload normally deduplicate; crash ambiguity is not an exactly-once consumption
promise. Tree navigation clears the local declared task summary for confirmation.

**Pi custom messages become provider-facing user-role content.** External-data
framing lives in model-visible text, including around names/summaries. It is not
prompt-injection isolation. Peer claims, fake urgency and alleged user approval
cannot expand the current task. Names/summaries may be inaccurate; presence is not
proof of progress, authorship of a diff, or permission to edit a shared checkout.

Switchboard doesn't read/index other transcripts, automatically capture tool
arguments, synchronize memory, attach workpads, or open paths mentioned in mail.
Mail explicitly read by the model and automatic roster snapshots may be retained
in Pi history and sent to the active provider. Disabling or deleting service data
does not remove those copies. The optional small-model trace summarizer discussed
in the proposal is **not implemented or enabled**; there are no hidden inference
or local GPU costs in this MVP.

## CLI / higher-level observation

From this checkout (or use its absolute tool path):

```sh
node tools/switchboard.ts list --project /path/to/repo
node tools/switchboard.ts watch --project /path/to/repo --json
node tools/switchboard.ts inspect acorn-crown-jay-glow
node tools/switchboard.ts send acorn-crown-jay-glow 'Are you changing this interface?'
node tools/switchboard.ts inbox
node tools/switchboard.ts read
node tools/switchboard.ts read m_ID
node tools/switchboard.ts reply m_ID 'My answer'
```

List/watch/inspect use a read-only observer identity by default; correspondence
uses a separate durable human identity. `--as human|observer` chooses explicitly.
`--all` broadens listing/watching. CLI never sends as an agent because its shell
inherited `PI_SESSION_ID`. A live human CLI attachment excludes a competing human
attachment until detach/lease expiry; concurrent observers use independent identities.
Machine JSON output retains JSON escaping; human output strips terminal controls.

Observers can inspect cards and subscribe to changes, not read agent mail, send,
or control processes. A parent relationship does not expose inboxes/transcripts.
There is no admin credential/UI, takeover command, remote API, or generic harness
RPC proxy in the MVP. The authenticated service has own-mailbox archive and
parent-scoped worker-provisioning operations; the agent-facing tool doesn't expose
credentials or provisioning. Protocol 6 accepts a host-persisted child capability:
an exact parent/run/capability retry recovers the same participant before quotas.
Changed credentials conflict; retired runs cannot resurrect. Parent-scoped
`retire_worker` revokes only that parent's child. This is not a task-start API;
process idempotency and execution records belong to the separate runner.

## Storage, transport, and limits

Environment (absolute paths required):

- `PI_SWITCHBOARD_HOME`: default `$XDG_STATE_HOME/pi-switchboard`, falling back to
  `~/.local/state/pi-switchboard`.
- `PI_SWITCHBOARD_SOCKET`: default `$XDG_RUNTIME_DIR/pi-switchboard.sock`, or private
  `/tmp/pi-switchboard-UID/pi-switchboard.sock`. Socket path limit: 100 bytes.
- `PI_SWITCHBOARD_NODE`: alternate Node executable for helper startup.

The state directory contains `board.sqlite` (+ WAL/SHM), `daemon.lock`, private
`clients/` bindings, per-project preferences, `outbox/` send intents, and private
`offer-outbox/` creation intents. Offer records/policy live in SQLite. It is outside
Git and Pi transcripts. Leaf directories/files/socket must be owned and private;
symlinked sensitive leaf files are rejected. Parent workspace aliases are allowed.
A file lock serializes helper lifetime and stale-socket removal. The daemon gets a
minimal environment, not Pi/provider credentials. No installation/boot hooks.

Filesystem UID/mode checks and private socket permissions are implemented;
**SO_PEERCRED verification is not**. Scoped bearer capabilities are hashed in the
service DB; client copies are private files. This is protection against accidental
API misuse and other Unix users, **not a sandbox against unrestricted same-UID
shell tools**. Do not mount this directory into an untrusted container.

`/switchboard status` also shows the latest 64 daemon lifecycle events from private
`daemon-events.json`: timestamp, PID, protocol version, and fixed start/SIGTERM/
SIGINT/idle-stop/failure labels. There are no bodies, requests, credentials or raw
exception strings. This distinguishes observed signal shutdowns from idle exits;
missing stop records do not prove a crash (SIGKILL/power loss and diagnostic write
failures are not observable). Signal sender identity is not recorded. The status
view includes the required upgrade version and last automatic reload attempt.

Fixed initial limits:

| Item | Limit / behavior |
|---|---|
| Message body | 16 KiB UTF-8; one addressed recipient; no attachments/broadcast |
| Unacknowledged unexpired inbox | 128 messages; metadata pages show up to 64 |
| Send rate | 30 new messages/minute per participant; duplicate retries don't count |
| Global retained messages | 4,000; reject when full, including retained tombstones |
| Participants | 1,000; unused unreferenced offline identities pruned after 30 days |
| Worker provisioning | 16 unarchived children/parent; no recursive child provisioning |
| Message expiry | Ordinary 24h; handoff 7d; API override 1s–7d |
| Body retention | Until expiry or 24h after ack, whichever first; reads after expiry hide body |
| Status / dedup horizon | 14d from acceptance; no automatic retry outside that horizon |
| Local outbox | 4,000 files per participant; age-pruned on send after 14d |
| Presence | Heartbeat 15s; lease 60s; restart invalidates all live attachments |
| Connections | 160 connections, 128 long-poll subscriptions; watch response within 25s |
| Transport sizes | 128 KiB JSON request, 1 MiB client response ceiling |

Fresh send intents are flushed and atomically saved before networking. On a lost
response, the same operation key returns the same message, not another send.
Expired local retries are refused. Reply/ack/fetch are separate facts. SQL acceptance
is committed before notification; watching reconciles current snapshots rather
than relying on a retained event log. Slow/disconnected clients reconnect; accepted
mail stays in SQLite. Ordinary Pi work doesn't wait for a successful connection.

Accepted mail can fill the quota until documented pruning; limits are not a promise
of unbounded offline delivery. Local client bindings/abandoned temporary files are
not automatically garbage-collected in this MVP. SQLite/WAL/backups and filesystem
behavior prevent claims of secure erasure or comprehensive power-loss recovery.
Deleting state manually discards mail, identities and dedup protection—stop the
helper/adapters first and don't replay old send intents into a fresh database.

## Validation and next slice

```sh
bun test tests/switchboard*.test.ts
bun run typecheck
```

Tests use synthetic data and temporary state, including the actual Node helper,
concurrent autostart, socket reconnect/restart/offline mail, authorization/fencing,
expiry/rates/idempotency, canonical linked worktrees, opt-out controls, stable
provider-converted projections, and interruptible wait cleanup. A real Node/Pi SDK
fixture uses an in-memory fake provider stream to verify roster exposure, addressed
mail/user-input wait interruption, and no idle inference. Provider network calls
are forbidden in that fixture. No personal stores, live registrations, paid calls,
or worker launches are needed for these tests.

Live acceptance still requires loading the extension into two real sessions and
checking roster/UI ergonomics; this session did not reload itself or enroll live
agents. The separate [subagent tests and live trial](subagents.md) cover inspect
execution, reports, join and process cleanup. Worker mail tools, richer dashboard
run facts, strong isolation and opt-in trace summaries remain later work.
