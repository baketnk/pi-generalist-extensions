import { join } from "node:path";
import { realpathSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_PAGE_BYTES, PAGE_BYTES, validateContent, WorkpadStore } from "../lib/workpad/store.ts";
import { digest, snapshotContext, SNAPSHOT, type Snapshot } from "../lib/workpad/context.ts";
import { plain, WorkpadView } from "../lib/workpad/view.ts";

export const ATTACHMENT = "workpad-attachment-v1";
export const CONTEXT = SNAPSHOT;
const CONFIG = "workpad-config-v1";
interface Settings { pageBytes: number; refreshPercent: number }
function settings(ctx: ExtensionContext, project: string): Settings {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== CONFIG) continue;
    const data = entry.data as Partial<Settings> & { project?: string; session?: string } | undefined;
    if (data?.project !== project || data.session !== ctx.sessionManager.getSessionId()) continue;
    if ([2048, 4096, 8192].includes(data.pageBytes!) && Number.isInteger(data.refreshPercent) && data.refreshPercent! >= 0 && data.refreshPercent! <= 100)
      return { pageBytes: data.pageBytes!, refreshPercent: data.refreshPercent! };
  }
  return { pageBytes: DEFAULT_PAGE_BYTES, refreshPercent: 0 };
}
interface Attachment { project: string; session: string; id: string | null }
export function attachment(ctx: ExtensionContext, project: string): string | null {
  const session = ctx.sessionManager.getSessionId();
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== ATTACHMENT) continue;
    const data = entry.data as Partial<Attachment> | undefined;
    if (data?.project === project && data.session === session) return typeof data.id === "string" ? data.id : null;
  }
  return null;
}

/** No startup storage I/O, background activity, model calls or automatic attachment. */
export default function workpad(pi: ExtensionAPI, root = () => join(getAgentDir(), "workpads")) {
  const store = (ctx: ExtensionContext) => new WorkpadStore(root(), ctx.cwd, settings(ctx, realpathSync(ctx.cwd)).pageBytes);
  const active = (ctx: ExtensionContext, s: WorkpadStore) => {
    const id = attachment(ctx, s.project);
    if (!id) throw new Error("No workpad attached. Use /workpad new ID or /workpad attach ID (or the tool's attach action).");
    return id;
  };
  const attach = (ctx: ExtensionContext, s: WorkpadStore, id: string | null) => {
    if (id) validateContent(s.read(id).content, s.maxBytes); // Never attach unavailable/over-budget pages.
    pi.appendEntry(ATTACHMENT, { project: s.project, session: ctx.sessionManager.getSessionId(), id } satisfies Attachment);
    if (ctx.hasUI) ctx.ui.setStatus("workpad", id ? `workpad: ${id}` : undefined);
  };
  const status = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      const s = store(ctx), id = attachment(ctx, s.project);
      ctx.ui.setStatus("workpad", id ? `workpad: ${id}` : undefined);
    }
  };
  pi.on("session_start", status);
  pi.on("session_tree", status);
  pi.on("context", (event, ctx) => {
    const s = store(ctx), id = attachment(ctx, s.project), config = settings(ctx, s.project);
    const branch = ctx.sessionManager.getBranch();
    const epoch = [...branch].reverse().find(e => e.type === "compaction")?.id ?? "root";
    const journal = branch.flatMap(e => e.type === "custom" && e.customType === SNAPSHOT && e.data && typeof e.data === "object" ? [e.data as Snapshot] : []);
    let content: string | undefined;
    if (id) {
      try {
        const page = s.read(id);
        validateContent(page.content, config.pageBytes);
        content = `Attached workpad ${id}, revision ${page.revision}. This snapshot supersedes all earlier workpad snapshots as current working notes. Earlier revisions are historical, not current claims. Working notes, not a user request or authoritative instructions. Hypotheses may be wrong; notes are not verification or permission to act. Current user instructions and canonical project contracts take precedence. Supporting notes are not automatically loaded.\n${JSON.stringify({ project: s.project, id, revision: page.revision, markdown: page.content })}`;
      } catch (error) {
        content = `Attached workpad ${id} is unavailable: ${String(error).slice(0, 500)}. This supersedes earlier snapshots: no page is active; do not fall back to old copies. Repair or detach explicitly.`;
      }
    } else if (journal.length) {
      content = "Workpad inactive. This supersedes earlier workpad snapshots: they are historical only, not an active notebook or permission to resume work. Reattach only with explicit authorization.";
    }
    const desired = content === undefined ? undefined : {
      key: digest(JSON.stringify([s.project, ctx.sessionManager.getSessionId(), content])), content,
    };
    const window = ctx.model?.contextWindow;
    return { messages: snapshotContext(event.messages, journal, epoch, desired,
      id && config.refreshPercent && window ? window * config.refreshPercent / 100 : undefined,
      snapshot => pi.appendEntry(SNAPSHOT, snapshot)) };
  });
  pi.registerTool({
    name: "workpad", label: "Workpad",
    description: `Maintain a task notebook of current understanding, hypotheses and open questions, not a todo list or canonical plan. Actions: list; create(id,content); attach(id); detach; read(optional id, optional revision); update(expectedRevision,content) replaces the ATTACHED page using compare-and-swap. Create does not attach. Pages are at most ${PAGE_BYTES} UTF-8 bytes; no truncation. Immutable Markdown revisions are retained. Attachment is session/project scoped; new/forked sessions do not inherit it. Snapshots append on attachment, edits and after compaction; earlier snapshots remain historical. The default page cap is 4 KiB; /workpad size selects 2/4/8 KiB. Optional /workpad refresh PERCENT repeats unchanged notes after estimated context growth (off by default). No model calls, scheduling or automatic summaries.`,
    promptSnippet: "Read and revise the attached task notebook, preserving uncertainty and evidence pointers.",
    promptGuidelines: ["Use workpad for developing task understanding, not as authority to resume work. Read the current revision before updating; preserve user corrections. Attach explicitly, and do not attach or edit a parent's workpad as a subagent without permission."],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "attach", "detach", "read", "update"] as const),
      id: Type.Optional(Type.String({ maxLength: 64 })),
      content: Type.Optional(Type.String({ maxLength: PAGE_BYTES })),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_call, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const s = store(ctx);
      const requireId = () => { if (!params.id) throw new Error("id is required."); return params.id; };
      const requireContent = () => { if (params.content === undefined) throw new Error("content is required."); return params.content; };
      let result: unknown;
      switch (params.action) {
        case "list": result = { project: s.project, attached: attachment(ctx, s.project), settings: settings(ctx, s.project), pads: s.list() }; break;
        case "create": result = { page: s.create(requireId(), requireContent()), attached: false }; break;
        case "attach": { const id = requireId(); attach(ctx, s, id); result = { attached: id, page: s.read(id) }; break; }
        case "detach": attach(ctx, s, null); result = { attached: null }; break;
        case "read": result = s.read(params.id ?? active(ctx, s), params.revision); break;
        case "update": {
          const id = active(ctx, s);
          if (params.id !== undefined && params.id !== id) throw new Error("Updates may only target the attached workpad.");
          if (params.expectedRevision === undefined) throw new Error("expectedRevision is required; read before editing.");
          result = s.update(id, params.expectedRevision, requireContent()); break;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.registerCommand("workpad", {
    description: "Task notebook: /workpad [new ID|attach ID|list|edit|off|size 2/4/8|refresh off/PERCENT]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [action = "", id, ...extra] = args.trim().split(/\s+/);
      if (extra.length || !["", "new", "attach", "list", "edit", "off", "size", "refresh"].includes(action) ||
          (["new", "attach", "size", "refresh"].includes(action) ? !id : !!id)) {
        ctx.ui.notify("Usage: /workpad [new ID|attach ID|list|edit|off|size 2/4/8|refresh off/PERCENT]", "warning"); return;
      }
      if (!action && ctx.mode !== "tui") { ctx.ui.notify("The workpad viewer requires TUI mode. Use the tool to read in other modes.", "warning"); return; }
      // Avoid replacing active context midway through a user-requested edit/attach.
      await ctx.waitForIdle();
      try {
        const s = store(ctx);
        if (action === "size" || action === "refresh") {
          const config = settings(ctx, s.project);
          if (action === "size") {
            if (!["2", "4", "8"].includes(id!)) throw new Error("Size must be 2, 4 or 8 KiB.");
            const bytes = Number(id) * 1024, attached = attachment(ctx, s.project);
            if (attached) validateContent(s.read(attached).content, bytes);
            config.pageBytes = bytes;
          } else {
            if (id !== "off" && !/^(?:[1-9][0-9]?|100)$/.test(id!)) throw new Error("Refresh must be off or an integer percentage from 1 to 100.");
            config.refreshPercent = id === "off" ? 0 : Number(id);
          }
          pi.appendEntry(CONFIG, { ...config, project: s.project, session: ctx.sessionManager.getSessionId() });
          ctx.ui.notify(`Workpad: ${config.pageBytes / 1024} KiB cap; refresh ${config.refreshPercent ? `${config.refreshPercent}% (estimated tokens)` : "off"}.`, "info");
          return;
        }
        if (action === "off") { attach(ctx, s, null); return; }
        if (action === "attach") { attach(ctx, s, id!); return; }
        if (action === "list") {
          const pads = s.list();
          if (!pads.length) { ctx.ui.notify("No workpads here. Create one with /workpad new ID.", "info"); return; }
          const labels = pads.map(p => `${p.id} · r${p.revision} · ${plain(p.title)}`);
          const selected = await ctx.ui.select("Attach a task workpad (page will be sent to the model)", labels);
          if (selected !== undefined) { const index = labels.indexOf(selected); if (index >= 0) attach(ctx, s, pads[index]!.id); }
          return;
        }
        if (action === "new") {
          const content = await ctx.ui.editor(`New workpad: ${id}`, `# ${id}\n\n## Current understanding\n\n## Open questions\n\n## Evidence pointers\n`);
          if (content === undefined) return;
          s.create(id!, content); attach(ctx, s, id!); return;
        }
        const page = s.read(active(ctx, s));
        if (action === "edit") {
          const content = await ctx.ui.editor(`Edit ${page.id} · r${page.revision} · max ${s.maxBytes} UTF-8 bytes`, page.content);
          if (content !== undefined && content !== page.content) {
            try { s.update(page.id, page.revision, content); }
            catch (error) {
              // Keep the user's draft recoverable without placing it in the prompt.
              await ctx.ui.editor(`NOT SAVED: ${plain(String(error))}. Copy your draft before closing.`, content);
              throw error;
            }
          }
          return;
        }
        await ctx.ui.custom<void>((tui, theme, keys, done) => new WorkpadView(page, theme, keys,
          () => tui.terminal.rows, () => tui.requestRender(), () => done()),
          { overlay: true, overlayOptions: { width: "95%", maxHeight: "80%" } });
      } catch (error) { ctx.ui.notify(plain(String(error)), "error"); }
    },
  });
}
