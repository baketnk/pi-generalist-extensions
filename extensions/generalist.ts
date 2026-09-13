import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import meitan from "./meitan.ts";
import optmem from "./optmem.ts";
import history from "./history.ts";
import workpad from "./workpad.ts";
import { registerSessionSetup } from "../lib/session-setup.ts";

/** One entrypoint guarantees toggles restore before the startup picker runs. */
export default function generalist(pi: ExtensionAPI) {
  registerSessionSetup(pi, { meitan: meitan(pi), optmem: optmem(pi) });
  history(pi);
  workpad(pi);
}
