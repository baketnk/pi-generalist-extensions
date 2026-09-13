import { test, expect } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryPanel, plain, type HistoryMatch } from "../lib/history/panel.ts";
import history from "../extensions/history.ts";

const keys = { matches: (data: string, action: string) => data === action.split(".").pop(), getKeys: (action: string) => [action.split(".").pop()] } as any;
const theme = { fg: (_: string, text: string) => text } as any;
const results: HistoryMatch[] = Array.from({ length: 20 }, (_, i) => ({
  harness: "pi", time: "2026-09-13", role: "assistant", cwd: "/workspace/日本語", title: "",
  excerpt: `match-${i} ` + "長いテキスト ".repeat(100), path: "/fixture/session.jsonl", locator: `line:${i}`,
  session: "fixture", entry: String(i), sourceChanged: true, sourceWarnings: ["fixture warning"],
}));

test("history table pages, expands cited excerpts, scrolls, goes back and closes", () => {
  let closed = 0, redraws = 0;
  const panel = new HistoryPanel("query", results, "0 warnings", theme, keys, () => 24, () => redraws++, () => closed++);
  expect(panel.render(110).join("\n")).toContain("DATE");
  panel.handleInput("pageDown");
  expect(panel.render(110).join("\n")).toContain("match-14");
  panel.handleInput("confirm");
  expect(panel.render(110).join("\n")).toContain("/fixture/session.jsonl (line:14)");
  panel.handleInput("pageDown");
  expect(panel.render(110).join("\n")).not.toContain("/fixture/session.jsonl");
  panel.handleInput("cancel"); expect(closed).toBe(0);
  panel.handleInput("cancel"); expect(closed).toBe(1);
  expect(redraws).toBeGreaterThan(0);
});

test("history rendering fits narrow/resized terminals and strips terminal controls", () => {
  expect(plain("\x1b]52;c;secret\x07hello\x1b[31mred\x1b[0m")).toBe("hellored");
  let rows = 24;
  const panel = new HistoryPanel("日本語", results, "ok", theme, keys, () => rows, () => {}, () => {});
  for (const detail of [false, true]) {
    if (detail) panel.handleInput("confirm");
    for (const width of [1, 10, 40, 80, 120]) {
      rows = width < 10 ? 5 : 24;
      const lines = panel.render(width);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.8));
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    }
  }
});

test("empty history is dismissible; non-TUI command never opens/indexes", async () => {
  let closed = false;
  const panel = new HistoryPanel("", [], "ok", theme, keys, () => 24, () => {}, () => closed = true);
  expect(panel.render(80).join("\n")).toContain("No matches");
  panel.handleInput("confirm"); panel.handleInput("cancel"); expect(closed).toBe(true);
  const commands: Record<string, any> = {};
  history({ registerTool() {}, registerCommand: (name: string, command: any) => commands[name] = command } as any);
  await commands.history.handler("test", { mode: "print", hasUI: false });
  let warning = "";
  await commands.history.handler("test", { mode: "rpc", hasUI: true, ui: { notify: (text: string) => warning = text } });
  expect(warning).toContain("terminal UI");
});
