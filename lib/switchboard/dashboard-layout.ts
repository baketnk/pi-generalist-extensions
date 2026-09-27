import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { plain } from "./shared.ts";

export interface DashboardRow {
  id: string;
  cells: Record<string, string>;
  search: string;
  group?: string;
}
export interface DashboardColumn {
  key: string;
  label: string;
  width: number;
  /** Lower priorities disappear first on narrow terminals. The first column always stays. */
  priority: number;
}

/** Display-cell padding, including CJK/emoji and trusted theme/input ANSI sequences. */
export function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Fixed, spaced columns; only the leading title column consumes surplus space. */
export function tableColumns(columns: DashboardColumn[], width: number): DashboardColumn[] {
  const result = columns.map(c => ({ ...c }));
  const needed = () => result.reduce((n, c) => n + c.width, 2) + (result.length - 1) * 2;
  while (result.length > 1 && needed() > width) {
    const drop = result.slice(1).reduce((a, b) => a.priority <= b.priority ? a : b);
    result.splice(result.indexOf(drop), 1);
  }
  result[0]!.width = Math.max(0, result[0]!.width + width - needed());
  return result;
}
export function tableLine(cells: Record<string, string>, columns: DashboardColumn[], selected = false): string {
  return (selected ? "› " : "  ") + columns.map(c => fit(plain(cells[c.key] ?? ""), c.width)).join("  ");
}

/** Project headings aren't selectable. Keep the selected row and its project heading visible. */
export function tableWindow(rows: DashboardRow[], selected: string | undefined, height: number) {
  const lines: ({ row: DashboardRow } | { group: string })[] = [];
  let group: string | undefined;
  for (const row of rows) {
    if (row.group !== undefined && row.group !== group) {
      group = row.group;
      lines.push({ group });
    }
    lines.push({ row });
  }
  const index = Math.max(0, lines.findIndex(line => "row" in line && line.row.id === selected));
  let start = Math.max(0, index - Math.floor(height / 2));
  start = Math.min(start, Math.max(0, lines.length - height));
  const visible = lines.slice(start, start + height);
  // A repeated heading takes a line, never the selected row's only line.
  if (height >= 2 && start > 0 && visible[0] && "row" in visible[0] && visible[0].row.group !== undefined) {
    const heading = visible[0].row.group;
    if (index === start + height - 1) visible.shift();
    else visible.pop();
    visible.unshift({ group: heading });
  }
  return visible;
}
