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
  expect(panel.render(110).join("\n")).toContain("match-13");
  panel.handleInput("confirm");
  expect(panel.render(110).join("\n")).toContain("/fixture/session.jsonl (line:13)");
  panel.handleInput("pageDown");
  expect(panel.render(110).join("\n")).not.toContain("/fixture/session.jsonl");
  panel.handleInput("cancel"); expect(closed).toBe(0);
  panel.handleInput("cancel"); expect(closed).toBe(1);
  expect(redraws).toBeGreaterThan(0);
});

test("history detail loads bounded conversation context and ignores a load after going back", async () => {
  let finish!: (context: any) => void;
  const load = () => new Promise<any>(resolve => finish = resolve);
  const panel = new HistoryPanel("query", results.slice(0, 1), "ok", theme, keys, () => 30, () => {}, () => {}, load);
  panel.handleInput("confirm");
  expect(panel.render(100).join("\n")).toContain("Loading conversation context");
  finish({ branch: "Recorded branch", warnings: [], sourceChangedSinceIndex: false, sourceChangedDuringRead: false,
    messages: [{ id: "0", role: "user", time: "2026-09-13", text: "surrounding conversation" }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const detail = panel.render(100).join("\n");
  expect(detail).toContain("CONTEXT — result 1 of 1");
  expect(detail).toContain("→ 2026-09-13 | user");
  expect(detail).toContain("surrounding conversation");
  expect(detail).toContain("┌"); expect(detail).toContain("┘");

  let late!: (context: any) => void;
  const leaving = new HistoryPanel("query", results.slice(0, 1), "ok", theme, keys, () => 30, () => {}, () => {},
    () => new Promise<any>(resolve => late = resolve));
  leaving.handleInput("confirm"); leaving.handleInput("cancel");
  late({ branch: "late", warnings: [], sourceChangedSinceIndex: false, sourceChangedDuringRead: false, messages: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(leaving.render(100).join("\n")).toContain("DATE");
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
