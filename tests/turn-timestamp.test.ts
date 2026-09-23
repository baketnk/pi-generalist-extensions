import { expect, test } from "bun:test";
import turnTimestamp, { formatTurnTimestamp } from "../extensions/turn-timestamp.ts";

test("formats an unambiguous UTC turn timestamp", () => {
  expect(formatTurnTimestamp(new Date("2026-09-17T12:34:56.789Z")))
    .toBe("Turn ended: 2026-09-17T12:34:56.789Z");
});

test("prints only at the final agent-settled boundary", async () => {
  const handlers = new Map<string, Function[]>();
  const notifications: Array<[string, string]> = [];
  const pi: any = {
    on: (event: string, handler: Function) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  };

  turnTimestamp(pi, () => new Date("2026-09-17T12:34:56.789Z"));

  expect([...handlers.keys()]).toEqual(["agent_settled"]);
  expect(notifications).toHaveLength(0);

  const handler = handlers.get("agent_settled")![0]!;
  await handler({}, { hasUI: true, ui: { notify: (...args: [string, string]) => notifications.push(args) } });
  expect(notifications).toEqual([["Turn ended: 2026-09-17T12:34:56.789Z", "info"]]);

  await handler({}, { hasUI: false, ui: { notify: () => { throw new Error("unexpected notification"); } } });
  expect(notifications).toHaveLength(1);
});
