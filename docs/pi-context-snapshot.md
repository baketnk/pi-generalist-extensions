# Pi fork-context observation hook

`patches/pi-context-snapshot.patch` is a **separate Pi-core patch**, not an extension
that reconstructs history and not an automatic installer. It adds a
`context_snapshot` event after every ordinary `context` handler has finished.

Each observer receives its own structured clone of the final `AgentMessage[]`.
Its return value is ignored; mutating its copy cannot alter another observer or
the messages returned to Pi. The event includes the current leaf ID, a count of
failed context handlers, and whether later `before_provider_request` handlers
exist. Observer exceptions are reported without changing the projected messages.

This boundary is **before provider conversion, image filtering and payload
hooks**. It is not a provider-request receipt, a copy of the system prompt, or
proof of cache reuse. The inspect runner refuses its default fork when context
transformation failed, and refuses forks when later payload hooks are registered.

A snapshot taken for the request that produces a delegating assistant message
precedes that entire assistant/tool batch. Forking uses that snapshot; it does
not copy the current JSONL tail, run context retrieval again, navigate the parent,
or invent missing tool results. Only actually captured checkpoints are offered.

## Source and verification

Developed against local `pi-mono` commit `d981de122`. The patch was generated
against saved pre-edit source, excluding unrelated local Code Mode/nested-tool
changes. It includes two new core tests. Those tests and the existing extension
runner tests passed together: **40 tests across two files**.

The local Pi source checkout and the installed SDK both identify as `0.85.1`,
but have different SDK APIs. Do not use the version string alone as a compatibility
check. The worker currently targets the installed ModelRuntime/state/streamFunction
API. The hook patch targets the inspected **source checkout**, not installed
`dist` files or a bundled CLI.

Before applying to another checkout, inspect it and use `git apply --check`.
Build and test that Pi version normally. No installed/global Pi distribution is
modified by this package. Without the event, fresh workers remain available and
fork requests fail explicitly; they never silently become fresh workers.
