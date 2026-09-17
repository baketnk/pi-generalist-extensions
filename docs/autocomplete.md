# Prompt autocomplete

An opt-in, UI-only extension (`extensions/autocomplete.ts`) with two independent completion sources:

- **Automatic history/n-gram ghost text:** reads the existing cross-harness history index; no model required.
- **Manual local-model ghost text:** press **Tab after a space** to ask Ollama to continue your draft.

No assistant turn, tool, automatic model request, context injection, or auto-submit. Unaccepted ghost text never enters the editor buffer or the conversation. This does not modify provider-bound context or cache-prefix projection.

## Enable

The package manifest includes the extension, but activation defaults **off**. Reload Pi after updating the package, then:

```text
/autocomplete on
```

If the history index is empty or stale, refresh it explicitly using the existing history extension:

```text
/history-index refresh
/autocomplete reload
```

Autocomplete never refreshes history automatically and never scans source conversations while you type. It reads the same configured Pi, OMP, Codex and Hermes sources through the existing index. `/autocomplete reload` reloads that index into memory, **not** the original sources.

If loading individual extension files instead of this package, load `extensions/autocomplete.ts` separately. The existing `extensions/generalist.ts` entrypoint alone does not register it.

## Keys

Ghosts appear at the **end of the whole draft**, not while editing in the middle.

| Key | Behavior |
| --- | --- |
| Type normally | History-prefix match, then a 1–3-word-context backoff predictor; partial-word vocabulary fallback |
| **Tab after a literal space** | Explicit Ollama request, even if a history suggestion is present |
| **Tab with a model suggestion already present** | Accept the complete model suggestion |
| **Tab inside a word** | Accept the next word/chunk of the history suggestion |
| **Right arrow** | Accept the entire available suggestion |
| **Alt+Right / Ctrl+Right** | Accept the next word/chunk |
| **Escape** | Cancel pending model work / dismiss the ghost |
| **Enter** | Submit only the actual draft; never silently accept ghost text |

A pending model call shows `local completion… Esc cancels` in the editor border. Input changes, cursor movement, programmatic replacement, branch navigation, disable and session teardown invalidate pending results. Results are also checked against current editor ownership/focus before display. No retry or provider fallback is automatic.

Tab in plain prose no longer opens the filesystem picker, even if there is no suggestion. Explicit `/commands`, `!shell` input, `@mentions`, and slash-containing paths retain native editor behavior. **For bare filenames use `./README.md` or `@README.md`**; `README.md` by itself is treated as prose. An already-open native completion menu takes precedence. Other app keys are delegated to `CustomEditor`.

Accepted chunks use the editor's atomic insertion/undo API. Long/multiline suggestions are previewed on the current visual line (`↵` marks newlines); narrow displays truncate the preview. A single offer is capped at 320 characters, so a longer historical entry may need repeated acceptance. Rendering does not alter the draft to simulate a ghost.

## Settings

```text
/autocomplete status
/autocomplete off
/autocomplete model llama3.2:3b
/autocomplete llm off
/autocomplete llm on
/autocomplete cpu on
/autocomplete cpu off
/autocomplete scope project
/autocomplete scope all
```

- `llm off` disables model requests; history/n-gram completion still works. Tab then accepts a word from history even after a space.
- `cpu on` sends Ollama `num_gpu: 0`. `cpu off` leaves device selection to Ollama. This is a request option, not a guarantee of acceptable CPU latency.
- `scope all` (default) uses all configured harnesses/projects and prefers exact current-project history matches. `scope project` requires exact recorded cwd equality; records with missing/different cwd are excluded.
- Changing the main Pi model does **not** change the autocomplete model.

Decisions persist in `<PI_CODING_AGENT_DIR>/autocomplete.json` (default `~/.pi/agent/autocomplete.json`). `PI_AUTOCOMPLETE_CONFIG` overrides the file location. No prompts, completions, or model outputs are saved there.

Default configuration:

```json
{
  "version": 1,
  "enabled": false,
  "modelEnabled": true,
  "model": "llama3.2:3b",
  "endpoint": "http://127.0.0.1:11434",
  "cpuOnly": false,
  "scope": "all"
}
```

The endpoint may be edited in this file before restarting/reloading Pi. Only loopback HTTP(S) origins are accepted; credentials, URL paths, query strings, redirects and known cloud model tags are rejected. This assumes your local Ollama daemon/model alias is actually local, not a separately configured proxy to a remote service.

No daemon startup, model download, warm-up, or persistent inference service is launched by this extension. The selected model must already be installed in an available Ollama server. Requests have a 60-second deadline to allow cold loading, 128 output tokens, 2048-token context configuration, a 32 KiB response bound, and a two-minute Ollama keep-alive. A manual request can therefore occupy GPU memory temporarily even after the suggestion is returned; disabling autocomplete cancels client work but does not forcibly unload other Ollama users' models.

## Data boundaries and limitations

The history adapter opens the **existing** index read-only, checks schema version and configured source permissions, and loads at most 3000 deduplicated short user-role prose messages / one million UTF-16 characters from 6000 recent candidate rows. It excludes tool/assistant/summary rows, overlapping continuation chunks, messages longer than 2000 characters or eight lines, terminal-control text, commands, and recognizable injected wrappers. Nothing is reparsed or reindexed on this path. Missing index is harmless; incompatible/unreadable index produces a warning and an empty corpus.

**User role does not prove human authorship.** The shared historical schema does not reliably distinguish all injected user messages from typed inputs. The wrapper filter is a heuristic, not a complete provenance filter or secret detector. Past prompts can contain sensitive text, and `scope all` can surface it across projects. Use project scope, change the history source allowlist, or turn autocomplete off when that is unwanted. After changing sources/deleting history, run `/autocomplete reload` or disable it to discard the in-memory snapshot. Indexed text may remain stale until the explicit history refresh.

New interactive `input` events update the in-memory predictor; extension-injected/RPC input is not learned. The predictor is disposable: it is rebuilt on activation/reload and not stored as another durable personal data store. Existing harness session persistence remains responsible for submitted prompts. Extension commands bypass Pi's `input` event and are not captured this way.

Only the current draft's final 2048 characters are sent to Ollama. No corpus examples, personal memory, assistant replies, tools, source paths, journals, or main-model context accompany it. Model output is parsed as a completion object and terminal controls are removed before display/insertion. Suggestions can still be wrong or invent intent: inspect them before accepting.

The statistical predictor is deliberately simple, not neural fine-tuning. Word tokenization favors languages with spaces; exact history matching and Unicode rendering are broader. The small model may produce generic text even though the history layer is personalized.

## Editor compatibility

This version takes exclusive ownership of Pi's custom-editor slot. It refuses to overwrite an existing custom editor and does not restore the default over a later replacement. Do not stack it with pi-history's editor, pi-autosuggestions, Frizbee, a Vim editor, or another ghost-text editor without a composition adapter.

It uses public editor APIs for edits, key handling and cursor state. The ghost renderer has one deliberately isolated dependency on Pi's rendered end-cursor marker; if that layout changes, it fails closed (no ghost), rather than mutating editor internals. Rendering and interaction tests exercise the installed Pi 0.85.1 editor. Visual testing in the user's terminal remains necessary.

## Verification

```sh
bun test tests/autocomplete.test.ts tests/autocomplete-lifecycle.test.ts
bun run typecheck
```

Tests use synthetic sources and mocked model responses, including real editor rendering, word/full acceptance, undo, manual-only requests, stale/ABA cancellation, ownership/focus checks, teardown, config rollback, read-only corpus boundaries, native completion delegation, and no context/tool registration. Live Ollama smoke tests should use synthetic drafts only.
