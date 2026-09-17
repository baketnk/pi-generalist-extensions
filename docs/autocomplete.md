# Prompt autocomplete

Opt-in, UI-only completion (`extensions/autocomplete.ts`):

- Automatic **history/n-gram ghosts** from the existing cross-harness index. No model needed; the predictor is unchanged by provider selection.
- Manual **model ghosts** through any explicitly selected, configured Pi provider. No automatic calls or fallback to your main model.

Unaccepted ghosts never enter the draft, conversation, or main model context. The extension registers no tools and does not change provider-bound conversation projection/cache prefixes.

## Enable and select a model

```text
/reload
/autocomplete on
/autocomplete model
```

`model` opens a searchable picker of Pi's configured, available models (including only the currently known installed models from dynamic providers such as Ollama). Or supply an **exact** `provider/model-id`, including any slashes inside the model ID:

```text
/autocomplete model local/llama3.2:3b
/autocomplete model openai/gpt-5.6-luna
/autocomplete model none
```

Examples only: use the actual IDs in your Pi catalog. A local provider may be called `local`, `ollama`, or something else. The extension neither creates providers nor downloads models. Unknown/unconfigured choices fail without changing the previous selection. Configure authentication in Pi, including the placeholder auth required by local OpenAI-compatible providers.

**Upgrade from direct Ollama:** v1 settings preserve history activation but clear the model selection instead of guessing a provider. Select a model once after `/reload`. The old `endpoint`/`cpuOnly` settings are retired; device placement and model-serving options now belong to Pi's provider configuration/local server. Main Pi model changes never change your autocomplete model.

This extension is included by the package manifest. If you load only `extensions/generalist.ts`, load `extensions/autocomplete.ts` separately.

## Keys

Ghosts appear at the **end of the whole draft**, not in the middle.

| Key | Behavior |
| --- | --- |
| Type normally | Exact history-prefix match, then a 1–3-word-context predictor and partial-word vocabulary fallback |
| **Tab** | Accept the next suggested word/chunk and ensure trailing whitespace; otherwise insert a space |
| **Ctrl+Tab** | Explicitly request a model continuation (with or without a trailing space) |
| **Ctrl+Space** | Same model-request action, for terminals that cannot distinguish Ctrl+Tab |
| **Right arrow** | Accept the entire available suggestion |
| **Alt+Right / Ctrl+Right** | Accept the next word/chunk |
| **Escape** | Cancel/dismiss |
| **Enter** | Submit only the actual draft, never an unaccepted ghost |

Plain Tab never calls a model. An empty draft also gets a space rather than triggering inference. A pending call shows `model completion… Esc cancels` in the border. Typing, cursor movement, replacement, conversation updates, branch navigation, settings changes, disable and shutdown invalidate pending results. Results/errors are checked against current editor ownership/focus before display.

Native command/path menus still take precedence. `/commands`, `!shell`, `@mentions`, and slash-containing paths retain native completion. For bare filenames use `./README.md` or `@README.md`; `README.md` alone is prose. Unhandled app keys go to `CustomEditor`.

Insertion uses Pi's atomic undo API. The single-row preview truncates to terminal width; `↵` marks newlines. Offers are capped at 320 characters, so longer historical entries may require repeated acceptance. Rendering never inserts unaccepted text to simulate a ghost.

## Context and privacy

```text
/autocomplete conversation on
/autocomplete conversation off
/autocomplete repo on
/autocomplete repo off
```

**Conversation context defaults on.** Each manual request uses:

- The draft's final 2048 characters.
- Up to four recent stored user/assistant prose messages from the active, compaction-aware branch: at most 1000 characters each / 3000 total; at most 100 entries inspected.
- No tool calls/results, thinking, images, custom memory/continuity messages, compaction/branch summaries, system prompt or other-harness history examples.

**Repo context defaults off.** With `/autocomplete repo on`, a trusted project's exact current-directory `AGENTS.md` and `README.md` contribute their first 1000 characters each, if present. No ancestor files, arbitrary paths, recursive reads, symlinks or nonregular files. Files over 1 MiB are skipped; reads are byte-bounded. Context is gathered only on a manual request, not on every keystroke. Excerpts are marked as background data, not instructions to execute.

**Selecting a remote provider sends the draft and enabled snippets to that provider and can incur charges.** Disable conversation/repo context to compare draft-only behavior. User-role injections and tool output quoted inside ordinary prose cannot be perfectly identified; recognizable injected envelopes are filtered, but this is not a secret detector. Choose your provider and context settings accordingly.

Model output is prose only; tool responses, failed responses and oversized output are rejected. Terminal controls are removed before display/insertion. No model/tool execution loop, main-agent turn, provider fallback, or automatic retry is added. The request asks Pi for up to 256 output tokens with thinking off by omission; providers/models may enforce their own reasoning/sampling behavior. Calls have a 60-second deadline and a 32 KiB generated-text bound. Provider/auth implementations are given cancellation; the client stops waiting even if an implementation ignores it.

The preferred API is `ctx.modelRegistry.streamSimple()`. Pi 0.85.1's older facade is supported through its configured provider plus resolved auth/headers/environment/base URL. It never uses pi-ai's global compatibility registry, which can miss extension-registered providers.

## Comparing models

Use `/autocomplete model` to switch among Luna, your current local model, or an installed fine-tuned model. Keep the draft and context toggles the same for a useful comparison. Changing model cancels/discards old model suggestions; history prediction stays unchanged.

`/autocomplete stats` reports per-model in-memory request/completion/error/cancellation counts and mean completed latency (including context/auth setup), capped at 32 model records. These reset on session start/reload. They are not acceptance-quality scores, provider invoices, or Pi session token/cost accounting. No prompt/output logs or automatic benchmark requests are saved.

## History and settings

```text
/history-index refresh
/autocomplete reload
/autocomplete status
/autocomplete scope project
/autocomplete scope all
/autocomplete llm off
/autocomplete off
```

`/autocomplete reload` rereads the **existing index**, not original conversations. Use the separate history extension's refresh explicitly when needed. History reads are read-only and use its configured Pi/OMP/Codex/Hermes roots. Up to 3000 deduplicated short user-role prose messages / one million UTF-16 characters are loaded from 6000 candidate rows. Assistant/tool/summary rows, continuation chunks, long messages, controls, commands and obvious injected envelopes are excluded. The corpus is disposable; new interactive input updates it in memory, while injected/RPC inputs are not learned.

`scope all` is the default and prefers current-project matches. `scope project` requires exact cwd equality. Past prompts can contain sensitive text and may surface across projects in all scope. Source removal or allowlist changes require `/autocomplete reload` or disabling to discard the in-memory snapshot. Neither user-role provenance nor freshness is guaranteed until the source/index is cleaned/refreshed. Original harness session persistence still handles submitted prompts.

Settings persist in `<PI_CODING_AGENT_DIR>/autocomplete.json` (default `~/.pi/agent/autocomplete.json`), overridable with `PI_AUTOCOMPLETE_CONFIG`. They contain only decisions, never prompt/output text:

```json
{
  "version": 2,
  "enabled": false,
  "modelEnabled": true,
  "model": null,
  "scope": "all",
  "conversation": true,
  "repository": false
}
```

Exclusive custom-editor ownership is required; do not stack other ghost/Vim/history editors without a composition adapter. It refuses to overwrite an existing editor and does not restore over a later replacement. The isolated ghost renderer depends on Pi's rendered cursor-marker layout and fails closed if that changes. Terminal visual checks remain necessary.

Tests: `bun test tests/autocomplete*.test.ts` and `bun run typecheck`. Synthetic sources/providers cover actual editor behavior, cancellation, read-only history, both provider facade paths with real Node/Pi auth composition, context filtering, settings and unchanged main-context data. No personal or paid model calls are needed for the tests.
