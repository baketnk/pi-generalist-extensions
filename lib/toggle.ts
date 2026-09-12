import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Branch-local state; CLI flags seed only branches with no saved decision. */
export function registerToggle(pi: ExtensionAPI, name: string, description: string,
  changed: (enabled: boolean, ctx: ExtensionContext) => void = () => {}) {
  const key = `generalist:${name}:enabled`;
  let enabled = false;
  pi.registerFlag(name, { description, type: "boolean", default: false });
  const update = (ctx: ExtensionContext) => {
    changed(enabled, ctx);
    if (ctx.hasUI) ctx.ui.setStatus(key, enabled ? `${name}: on` : undefined);
  };
  const restore = (ctx: ExtensionContext) => {
    enabled = pi.getFlag(name) === true;
    let saved = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === key &&
          typeof (entry.data as { enabled?: unknown })?.enabled === "boolean") {
        enabled = (entry.data as { enabled: boolean }).enabled;
        saved = true;
      }
    }
    if (!saved && enabled) pi.appendEntry(key, { enabled });
    update(ctx);
  };
  const set = (value: boolean, ctx: ExtensionContext) => {
    enabled = value;
    pi.appendEntry(key, { enabled });
    update(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand(name, {
    description: `${description} [on|off|status] (no argument toggles)`,
    getArgumentCompletions: prefix => ["on", "off", "status"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        if (ctx.hasUI) ctx.ui.notify(`Usage: /${name} [on|off|status]`, "warning");
        return;
      }
      if (action !== "status") {
        await ctx.waitForIdle();
        set(action === "" ? !enabled : action === "on", ctx);
      }
      if (ctx.hasUI) ctx.ui.notify(`${name}: ${enabled ? "on" : "off"}`, "info");
    },
  });
  return Object.assign(() => enabled, { set });
}
