# Switchboard dashboard and interactive offers

Implemented milestone: **live model-free dashboard + human-approved interactive task
offers**. This is not the entire [orchestration proposal](switchboard-dashboard-proposal.md).
Coordinator model calls, managed workers, automatic follow-up/new-session policies,
dependency groups, and integration commits are not implemented.

## Open and inspect

- `/switchboard`, `/switchboard dashboard`, and `/generalist dashboard` open the
  same fullscreen TUI overlay; the `/generalist` settings list also links to it.
  This fills the terminal without changing Pi's global TUI mode.
- Requires Pi TUI mode. RPC gets an explanatory notice; CLI `watch` remains available.
- The human-only Agents/Mail views read the same daemon through the existing
  adapter credential, independently of its **project-scoped model-visible watch**.
  They refresh every 15 seconds while open (and on `r`), without model calls,
  context publication, or another watch subscription. Closing/reloading removes
  UI listeners and cancels outstanding viewer reads.

Controls:

| Key | Action |
|---|---|
| Tab / Shift+Tab | Cycle Sessions/Agents / Mail / Offers forward/backward |
| ↑↓, PgUp/PgDn | Move selection in the table, or scroll the focused details pane |
| ← / → | Focus table / details (Tab always switches views) |
| / | Edit local filter (Enter/Esc leaves filter editing) |
| r | Explicit snapshot refresh |
| o | Compose a human task offer |
| p | Configure this participant's task-offer policy |
| Esc | Leave filter editing, otherwise close and cancel outstanding reads |

The Codex-inspired command center uses a spaced-column table on the left and a
38-column details pane on the right. Below 94 terminal columns, details stack beneath
the table; very short terminals reduce headings before content. Columns drop by
priority when space is tight. Project headings and indented children preserve the
roster's grouping; Mail is a flat message table, not a conversation view.

UI copy is limited to headings, property labels/values, controls and operational
status/errors. Provenance and behavioral caveats live in code comments and this
document rather than repeated annotations in the dashboard or offer dialogs.

**Details follow selection automatically; Enter is not needed.** Selection and filters
are remembered separately for each tab while the dashboard is open. Inspecting a
participant does not contact it, and viewing mail does not acknowledge or deliver it.
Press **o** to create a task offer; the recipient must still accept and separately
Start it. The **p** control changes offer policy, not automatic acceptance or worker
availability; this UI change introduces no new offer lifecycle or terminal launcher.

Agents lists registrations across **all projects**, including subagents and retired
workers, grouped by project/parent. The daemon supplies up to 128 entries, live
registrations first, followed by retained offline sessions **started in the last 24
hours** (not those merely active within the last 24 hours). Retired workers are not addressable.
This is not a census of Pi session files or processes: unregistered sessions, opt-outs,
older offline sessions, and pruned identities are absent. The count shows omissions.
A failed connection retains the last view with a historical label.

Agent inspection shows canonical checkout/cwd, service relationship links,
service heartbeat timestamps, declared names/summaries, and adapter-reported activity.
**Heartbeat age is not idle duration.** Registration is partial, not a process census;
offline peers disappear from the **model-visible live roster**. Human Mail combines
all pending incoming mail (up to 128) and the latest 50 acknowledged/expired entries.
The table contains metadata only; selecting a message automatically loads its body
into the details pane using `peek`, without updating fetched or acknowledgement
receipts. Offers remain a separate tab with automatic selected-task previews. The
model-visible roster/inbox and its cache-stable context projection are unchanged.

Only the selected mail/offer body is loaded, not every row's body. Navigation, tab
changes, changed metadata, expiry and close cancel superseded detail reads; late
responses cannot replace the current selection. Failed reads wait for **r** or a new
selection rather than retrying on every render. Viewing never acknowledges mail,
copies bodies to model context, or starts a model. External terminal controls are
removed for display, not executed; theme styling and the filter's IME cursor remain.
Agent details follow the latest metadata; body previews show their snapshot age and
scroll position. Use **r** to refresh/retry the selected preview.

## Offer a task

1. Press **o**, select a registered project participant or enter an exact ID/full
   handle (including an offline participant that permits queued offers).
2. Write the original task in the editor. No model decomposes or rewrites it.
3. Confirm recipient, checkout, policy generation, and 24-hour expiry.
4. The recipient sees an Offers tab row and footer attention count. Nothing runs.

The recipient inspects the original task, then uses:

- **a**: accept. This alone does **not** start execution.
- **d**: decline an offered or accepted task.
- **s**: separately confirm Start, using the foreground session's current model,
  thinking, tools, and conversation. Refuses while the session has active or queued
  work. It never replaces the session. The original task is appended verbatim inside
  explicit human-accepted offer provenance; it is not a coordinator paraphrase or
  ordinary peer mail promoted to user authority.
- **x**: close an uncertain delivery as `delivery-unknown`, after inspecting session
  history/queued prompts. This does not retry the task, assert that it was not delivered,
  or stop any work already running; it unblocks *other* offers.

The creator can use **c** to cancel before delivery is claimed. Accept/decline/cancel
use optimistic generations; concurrent or stale actions fail rather than guessing.
The server independently revalidates actor ownership, policy, scope, checkout, expiry,
state, and attachment. No broad repository staging/commit authorization is implied.

## Policy is separate from automatic context exposure

Offer policy is participant-owned and stored in service SQLite, outside branch rewind:

- `manual` (default): accepts offers only while the recipient is online; human
  acceptance and Start still required. Busy is not automatically eligible to start.
- `queue`: allows offline offer creation, but never wakes/launches a process or
  automatically accepts/starts a task when it returns.
- `off`: rejects new offers and prevents acceptance/start. Existing offers remain
  visible for inspection, decline, or creator cancellation.

These are **not** `/switchboard manual|auto`, which control automatic model-visible
roster/mail observations. Offer metadata is currently human-facing only; no new tool
schema, automatic prompt publication, coordinator model, or hidden provider call.
A new/forked participant gets default policy; reload/resume of the same authorized
binding retains it. Project/session registration opt-out remains unchanged.

## Lifecycle and uncertainty

```text
offered → accepted → delivery-claimed → delivered
   │          │               └────→ delivery-unknown (explicit human resolution)
   └──────────┴──→ declined | cancelled | expired
```

`delivery-claimed` is a durable exclusive intent, **not** evidence that Pi received
anything. Pi's extension `sendUserMessage()` returns void and can fail asynchronously
during auth, compaction, input interception, or prompt preflight. The adapter therefore
marks `delivered` only after observing the exact task as a Pi user-message lifecycle
event in the same live runtime. This means **message delivery**, not model success,
execution completion, result availability, or result collection.

Claims are never restored into automatic delivery after reload/restart/tree/fork. A
crash between claiming and receipt, transformed/handled input, or lost receipt response
leaves an uncertain claim. No blind retry; inspect session history. An unresolved claim
blocks other delivery claims to that recipient until explicitly resolved. Even after
resolution, that original task is not eligible for another Start.

Creation writes a private durable intent before networking. On a lost creation response,
use the exact operation ID reported in the error:

```text
/switchboard offer-retry human-offer:UUID
```

This queries/retries the same creation operation and returns the same offer, without
starting anything. Changed content with the same key fails. Other transitions have
CAS generations; after an uncertain response, refresh/inspect rather than repeat a
new action blindly.

## Limits and authority boundary

- Protocol **v8**, SQLite schema **v3**; reload participating adapters together.
  Existing daemon upgrade/reconnect machinery applies. Downgrade of schema v3 to old
  code is not supported; mixed old/new adapters are not a supported steady state.
- Same canonical project only; recipient checkout is pinned. Candidate policy and
  checkout changes invalidate creation; recipient checkout/policy changes can block
  acceptance/Start. No tool/capability matching, Git isolation, or resource scheduling.
- Task: 16 KiB UTF-8. UI expiry: 24h; protocol TTL: 60s–7d. At most eight nonterminal
  offers per recipient, ten creations/minute per creator, 2,000 retained offers.
- Completed/declined/cancelled/expired/resolved-unknown records are pruned after 30 days
  from creation; unresolved delivery claims are retained. Local creation retries refuse
  after 30 days. Private `offer-outbox/` intents are age-pruned on later creation.
- Original tasks stay in private service/outbox storage until pruning. Accepted Start
  puts the task in Pi history and sends it to the current provider. Service deletion
  cannot erase downstream copies. SQLite/WAL/backups preclude secure-erasure claims.
- Authenticated adapters attest `human-ui` provenance. The daemon enforces creator,
  recipient, attachment, scope, generations and policy, but **does not cryptographically
  distinguish a human keypress from code holding that adapter credential**. Same-UID
  unrestricted shell remains outside this boundary. The agent-facing switchboard tool
  does not expose offer creation, acceptance, policy upgrades, or delivery operations.
- No coordinator, worker launch, session replacement, auto-dispatch, background inference,
  assignment completion inference, or Git mutation/commit is provided by these controls.

## Validation

```sh
bun test tests/switchboard-dashboard.test.ts tests/switchboard-offers.test.ts \
  tests/switchboard.test.ts tests/switchboard-adapter.test.ts \
  tests/switchboard-handles.test.ts tests/generalist-settings.test.ts
bun run typecheck
```

Synthetic tests and layout snapshots cover fullscreen dimensions, fixed-width columns,
wide/stacked layouts, Unicode, IME focus, per-tab stable-ID selection/filtering,
automatic selected-body peeks, out-of-order responses, cancellation/disposal, stale
coverage, policy/scope/checkout/expiry/CAS,
concurrent claims, lost creation responses, restart ambiguity, and human Start guards.
A Node/Pi SDK fixture drives the actual extension/Generalist command path through a
scripted UI: automatic mail/offer previews and acceptance cause no inference or mail
receipt changes; explicit Start produces one task
message and an observed delivery receipt. It checks the actual outgoing provider
message prefix and unchanged model/thinking/tools/system prompt using a scripted
stream with provider networking forbidden. Existing adapter tests cover ordinary
turn/tool-follow-up/retry/compaction/reload context projection semantics separately.

These are not physical-terminal or paid-provider acceptance tests. Real multi-session
keyboard/layout ergonomics still need human evaluation after reload. Managed worker
and integration workflows have not been implemented or trialled.
