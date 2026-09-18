import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
        const title = ` Subagents · ${runtime.activeCount}/${runtime.maxActive} live (ceiling, not staffing target) `;
        const content = detail && record ? [
          `${record.id} · ${record.label}`, `${record.mode} · ${record.model.provider}/${record.model.id} · ${record.thinking}`,
          record.taskSummary ? `Task: ${record.taskSummary}` : "",
          `task=${record.taskState} process=${record.process} cleanup=${record.cleanup}`,
          `turns=${record.turns} tools=${record.tools} input=${record.usage.input} output=${record.usage.output} cacheRead=${record.usage.cacheRead} cost=${record.usage.cost}`,
          record.source ? `fork of ${record.source.session}@${record.source.anchor}` : "fresh context",
          record.question ? `BLOCKED ${record.question.id}: ${record.question.text}` : "",
          record.report ? `Report (unverified): ${JSON.stringify(record.report)}` : "No structured report yet.",
          record.reason ?? "", record.persistenceError ?? "", record.sessionFile ? `Session artifact: ${record.sessionFile}` : "", events,
        ].filter(Boolean).join("\n") : runs.length ? runs.flatMap(r => [
          `${r.id === selected ? "›" : " "} ${r.label} · ${r.mode} · ${r.taskState}/${r.process}${r.collectedAt ? " · collected" : ""}`,
          `  ${r.taskSummary ?? r.id}`,
        ]).join("\n") : "No runs. The main agent chooses zero, one, or several independent investigations.";
        // Preserve intentional newlines while removing terminal control sequences.
        if (width < 3) return [truncateToWidth(title, width), ...new Text(content.split("\n").map(plain).join("\n"), 0, 0).render(Math.max(1, width)).slice(0, Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 2))];
        const inner = width - 2, contentWidth = Math.max(1, inner - 2);
        const lines = new Text(content.split("\n").map(plain).join("\n"), 0, 0).render(contentWidth);
        const height = Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 4);
        scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - height)));
        const border = (value: string) => theme.fg("borderAccent", value);
        const row = (value: string) => {
          const clipped = truncateToWidth(value, inner, "…", true);
          return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
        };
        const heading = truncateToWidth(title, inner, "…");
        const help = detail ? " ↑↓ scroll · Enter back · Esc close (worker continues)" : " ↑↓ select · Enter inspect · Esc close (workers continue)";
        return [border("╭") + theme.fg("accent", heading) + border("─".repeat(Math.max(0, inner - visibleWidth(heading))) + "╮"),
          ...lines.slice(scroll, scroll + height).map(line => row(` ${line}`)),
          ...(error ? [row(theme.fg("error", ` ${plain(error)}`))] : []),
          row(theme.fg("dim", help)), border(`╰${"─".repeat(inner)}╯`)];
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
