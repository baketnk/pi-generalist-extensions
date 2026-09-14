import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { plain } from "../switchboard/shared.ts";
import type { SubagentRuntime } from "./runtime.ts";

/** Inspection only: no model call, input delivery, collection, or session navigation. */
export async function openRuns(ctx: ExtensionContext, runtime: SubagentRuntime) {
  if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify(JSON.stringify(runtime.list()), "info"); return; }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let selected: string | undefined, detail = false, scroll = 0, events = "", error = "", closed = false, loading = false;
    const refresh = async () => {
      if (loading || !detail || !selected || closed) { tui.requestRender(); return; }
      loading = true; const id = selected;
      try { const page = await runtime.peekTail(id); if (!closed && selected === id) events = page.events.map(e => `${e.seq} ${e.kind}${e.tool ? ` ${e.tool}` : ""}${e.text ? `: ${e.text}` : ""}`).join("\n") + (page.more ? "\nLatest bounded events shown. Earlier pages: subagents.peek(after=0)." : ""); }
      catch (e) { if (!closed) error = String(e); }
      finally { loading = false; if (!closed) tui.requestRender(); }
    };
    const unsubscribe = runtime.subscribe(() => { if (runtime.closed) close(); else void refresh(); });
    const close = () => { if (closed) return; closed = true; unsubscribe(); done(); };
    return {
      render(width: number) {
        const runs = runtime.list();
        if (!runs.some(r => r.id === selected)) selected = runs[0]?.id;
        const record = runs.find(r => r.id === selected);
        const title = ` Subagents · ${runtime.activeCount}/${runtime.maxActive} live (ceiling, not staffing target)`;
        const content = detail && record ? [
          `${record.id} · ${record.label}`, `${record.mode} · ${record.model.provider}/${record.model.id} · ${record.thinking}`,
          `task=${record.taskState} process=${record.process} cleanup=${record.cleanup}`,
          `turns=${record.turns} tools=${record.tools} input=${record.usage.input} output=${record.usage.output} cacheRead=${record.usage.cacheRead} cost=${record.usage.cost}`,
          record.source ? `fork of ${record.source.session}@${record.source.anchor}` : "fresh context",
          record.question ? `BLOCKED ${record.question.id}: ${record.question.text}` : "",
          record.report ? `Report (unverified): ${JSON.stringify(record.report)}` : "No structured report yet.",
          record.reason ?? "", record.persistenceError ?? "", record.sessionFile ? `Session artifact: ${record.sessionFile}` : "", events,
        ].join("\n") : runs.length ? runs.map(r => `${r.id === selected ? "›" : " "} ${r.id}  ${r.label}  ${r.mode}  ${r.taskState}/${r.process}${r.collectedAt ? " · collected" : ""}`).join("\n") : "No runs. The main agent chooses zero, one, or several independent investigations.";
        // Preserve intentional newlines while removing terminal control sequences.
        const lines = new Text(content.split("\n").map(plain).join("\n"), 0, 0).render(Math.max(1, width - 2));
        const height = Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 4);
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - height)));
        return [theme.fg("accent", truncateToWidth(title, width)), ...lines.slice(scroll, scroll + height).map(l => truncateToWidth(l, width)),
          ...(error ? [theme.fg("error", truncateToWidth(plain(error), width))] : []),
          theme.fg("dim", truncateToWidth(detail ? "↑↓ scroll · Enter back · Esc close (worker continues)" : "↑↓ select · Enter inspect · Esc close (workers continue)", width))];
      },
      invalidate() {},
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) { close(); return; }
        if (keys.matches(data, "tui.select.confirm")) { detail = !detail; scroll = 0; void refresh(); }
        else {
          const delta = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : 0;
          if (detail) scroll += delta;
          else { const runs = runtime.list(), index = Math.max(0, runs.findIndex(r => r.id === selected)); selected = runs[Math.max(0, Math.min(runs.length - 1, index + delta))]?.id; }
        }
        tui.requestRender();
      },
      dispose() { closed = true; unsubscribe(); },
    };
  }, { overlay: true, overlayOptions: { width: "95%", maxHeight: "85%" } });
}
