import { expect, test } from "bun:test";
import { registerStatusIcons } from "../lib/status-icons.ts";
import { registerToggle } from "../lib/toggle.ts";

function harness() {
  const events: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  const entries: any[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx: any = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    waitForIdle: async () => {},
    ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]), notify() {} },
  };
  const pi: any = {
    on: (name: string, handler: Function) => (events[name] ??= []).push(handler),
    registerCommand: (name: string, command: any) => commands[name] = command,
    registerFlag() {}, getFlag: () => true,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const icons = registerStatusIcons(pi);
  const feature = registerToggle(pi, "meitan", "Fixture", undefined, icons);
  const emit = async (name: string) => { for (const handler of events[name] ?? []) await handler({}, ctx); };
  return { commands, statuses, ctx, emit, feature };
}

test("status-icons shows each Generalist boolean with a labelled check or cross", async () => {
  const h = harness();
  await h.emit("session_start");
  expect(h.feature()).toBe(true);
  expect(h.statuses.at(-1)).toEqual(["generalist:meitan:enabled", "meitan: on"]);

  await h.commands["status-icons"].handler("on", h.ctx);
  expect(h.statuses.at(-1)).toEqual(["generalist:meitan:enabled", "meitan: ✓"]);

  h.feature.set(false, h.ctx);
  expect(h.statuses.at(-1)).toEqual(["generalist:meitan:enabled", "meitan: ✗"]);

  await h.commands["status-icons"].handler("off", h.ctx);
  expect(h.statuses.at(-1)).toEqual(["generalist:meitan:enabled", undefined]);
});
