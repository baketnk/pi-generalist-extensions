import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import meitan from "./meitan.ts";
import memory from "./memory.ts";
import history from "./history.ts";
import workpad from "./workpad.ts";
import evidence from "./evidence.ts";
import continuity from "./continuity.ts";
import tasks from "./tasks.ts";
import questions from "./questions.ts";
import applyPatch from "./apply-patch.ts";
import { registerGeneralistSettings } from "./generalist-settings.ts";
import { registerSessionSetup } from "../lib/session-setup.ts";
import { registerStatusIcons } from "../lib/status-icons.ts";
import { loadGeneralistDefaults } from "../lib/generalist-config.ts";

/** One entrypoint guarantees toggles restore before the startup picker runs. */
export default function generalist(pi: ExtensionAPI) {
  const defaults = loadGeneralistDefaults();
  const icons = registerStatusIcons(pi, () => defaults?.icons);
  const toggles = {
    meitan: meitan(pi, icons, () => defaults?.meitan),
    memory: memory(pi, icons, () => defaults?.memory),
    patch: applyPatch(pi, icons, () => defaults?.patch),
    icons,
  };
  registerSessionSetup(pi, toggles);
  registerGeneralistSettings(pi, toggles, defaults);
  history(pi);
  workpad(pi);
  evidence(pi);
  continuity(pi);
  tasks(pi);
  questions(pi);
}
