import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STATUS_ICONS_ENTRY = "generalist:status-icons-v1";

export type StatusIconsController = (() => boolean) & {
  set(value: boolean, ctx: ExtensionContext): void;
  format(name: string, enabled: boolean): string | undefined;
  onChange(listener: () => void): void;
};

/**
 * Branch-local presentation preference for the Generalist feature indicators.
 * Unicode is sent verbatim; the terminal decides whether to render check/cross glyphs or a fallback.
 */
export function registerStatusIcons(pi: ExtensionAPI, defaultEnabled?: () => boolean | undefined): StatusIconsController {
  let enabled = false;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const restore = (ctx: ExtensionContext) => {
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATUS_ICONS_ENTRY &&
          typeof (entry.data as { enabled?: unknown })?.enabled === "boolean") {
        enabled = (entry.data as { enabled: boolean }).enabled;
      }
    }
    const defaultValue = defaultEnabled?.();
    if (!ctx.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === STATUS_ICONS_ENTRY) && defaultValue !== undefined) {
      enabled = defaultValue;
      pi.appendEntry(STATUS_ICONS_ENTRY, { enabled });
    }
    changed();
  };
  const set = (value: boolean, _ctx: ExtensionContext) => {
    enabled = value;
    pi.appendEntry(STATUS_ICONS_ENTRY, { enabled });
    changed();
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("status-icons", {
    description: "Use ✓/✗ Generalist footer status indicators [on|off|status]",
    getArgumentCompletions: prefix => ["on", "off", "status"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /status-icons [on|off|status]", "warning");
        return;
      }
      if (action !== "status") {
        await ctx.waitForIdle();
        set(action === "" ? !enabled : action === "on", ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(`Status icons: ${enabled ? "on" : "off"}`, "info");
    },
  });
  return Object.assign(() => enabled, {
    set,
    format: (name: string, active: boolean) => enabled ? `${name}: ${active ? "✓" : "✗"}` : active ? `${name}: on` : undefined,
    onChange: (listener: () => void) => { listeners.add(listener); },
  });
}
