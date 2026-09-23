import { expect, test } from "bun:test";
import switchboard from "../extensions/switchboard.ts";

function renderer() {
  let tool: any;
  switchboard({ on() {}, registerTool(value: unknown) { tool = value; }, registerCommand() {} } as any);
  const theme = { fg: (_color: string, text: string) => text };
  return (action: string, receipt: unknown, args: unknown, options = {}, isError = false) => {
    const result = { content: [{ type: "text", text: "unchanged model receipt" }], details: { action, result: receipt } };
    const before = JSON.stringify(result);
    const rendered = tool.renderResult(result, options, theme, { args, isError }).render(100).join("\n");
    expect(JSON.stringify(result)).toBe(before);
    return rendered;
  };
}

const receipt = { id: "m_test", sender: "p_sender", recipient: "p_recipient", kind: "note", createdAt: 1, fetchedAt: null, ackAt: null };

test("send and reply show the full outgoing body without expanding or modifying model results", () => {
  const render = renderer();
  for (const action of ["send", "reply"]) {
    for (const expanded of [false, true]) {
      const output = render(action, receipt, { action, body: "First line\nSecond line 狸\nLast line" }, { expanded });
      expect(output).toContain("First line");
      expect(output).toContain("Second line 狸");
      expect(output).toContain("Last line");
      expect(output).toContain("From: p_sender");
      expect(output).toContain("To: p_recipient");
      expect(output).toContain("State: new");
    }
  }
});

test("outgoing display sanitizes controls and preserves supplied receipt bodies", () => {
  const render = renderer();
  const output = render("send", receipt, { body: "hello\x1b[31m red\x07\nworld" });
  expect(output).toContain("hello");
  expect(output).toContain("world");
  expect(output).not.toContain("\x1b");
  expect(output).not.toContain("\x07");
  expect(render("send", { ...receipt, body: null }, { body: "not resurrected" })).toContain("Message body expired");
  expect(render("send", { ...receipt, body: "stored body" }, { body: "not substituted" })).toContain("stored body");
});

test("missing args, non-send actions and errors do not invent a sent body", () => {
  const render = renderer();
  expect(render("send", receipt, {})).not.toContain("undefined");
  for (const action of ["delivery", "ack", "read", "retry"]) {
    expect(render(action, receipt, { body: "not sent" })).not.toContain("not sent");
  }
  expect(render("send", receipt, { body: "not sent" }, {}, true)).not.toContain("not sent");
});
