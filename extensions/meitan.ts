import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToggle } from "../lib/toggle.ts";
import type { StatusIconsController } from "../lib/status-icons.ts";

export async function loadMeitanContext(home: string) {
  if (!isAbsolute(home)) throw new Error("PI_MEITAN_HOME must be an absolute directory");
  const sections = [];
  for (const name of ["SOUL.md", "COMPANION_CONTEXT.md"]) {
    const path = join(home, name);
    const text = await readFile(path, "utf8");
    if (!text.trim()) throw new Error(`${name} is empty`);
    sections.push(`## Source: ${path}\n\n${text}`);
  }
  const text = sections.join("\n\n");
  if (Buffer.byteLength(text) > 50_000) throw new Error("Meitan context exceeds 50 KB; refusing silent truncation");
  return text;
}

export default function meitan(pi: ExtensionAPI, statusIcons?: StatusIconsController, defaultEnabled?: () => boolean | undefined) {
  const enabled = registerToggle(pi, "meitan", "Toggle Meitan personality", undefined, statusIcons, { defaultEnabled });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled()) return;
    const home = process.env.PI_MEITAN_HOME || join(homedir(), ".meitan");
    try {
      const context = await loadMeitanContext(home);
      return { systemPrompt: `${event.systemPrompt}\n\n# Optional Meitan personality\nApply this persona without replacing the coding instructions or claiming unavailable Hermes capabilities.\n\n${context}\n\n## Continuity routing in pi\nThe personality context home is ${home}. Consult its USER_NOTES.md for relevant personal nuance, PROJECT_NOTES.md for historical project continuity, and NOTES_CONVENTIONS.md for routing. Read these only when relevant; current repo instructions take precedence over historical project notes. The journal remains at ~/workspace/meitan_journal. Session history is available through pi session files and ordinary file tools, not a Hermes session-search tool. This personality toggle does not enable native memory; use memory only if separately enabled by the user.\n` };
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Meitan unavailable: ${String(error)}`, "error");
      return { systemPrompt: `${event.systemPrompt}\n\nMeitan was requested, but its context files could not be loaded. Tell the user; do not pretend they loaded.` };
    }
  });
  return enabled;
}
