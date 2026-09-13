import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Branch-local diagnostic preference shared by all bundle entrypoints. */
export const OUTPUT_CONFIG_ENTRY = "generalist:output-config-v1";

export function rawJsonOutput(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): boolean {
  if (!ctx?.sessionManager?.getBranch) return false;
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== OUTPUT_CONFIG_ENTRY) continue;
    const data = entry.data as { rawJson?: unknown } | undefined;
    if (typeof data?.rawJson === "boolean") return data.rawJson;
  }
  return false;
}

function label(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
}

function plain(value: unknown, indent = ""): string[] {
  if (value === null || value === undefined) return ["none"];
  if (typeof value === "string") return value.split("\n").map(line => `${indent}${line}`);
  if (typeof value === "number" || typeof value === "boolean") return [`${indent}${value}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}None.`];
    return value.flatMap(item => {
      if (item && typeof item === "object") {
        const lines = plain(item, `${indent}  `);
        return [`${indent}- ${lines[0]!.trimStart()}`, ...lines.slice(1)];
      }
      const lines = plain(item);
      return [`${indent}- ${lines[0]}`, ...lines.slice(1).map(line => `${indent}  ${line}`)];
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [`${indent}None.`];
    return entries.flatMap(([key, item]) => {
      const prefix = `${indent}${label(key)}:`;
      if (item !== null && typeof item === "object") return [prefix, ...plain(item, `${indent}  `)];
      const lines = plain(item);
      return [`${prefix} ${lines[0]!.trimStart()}`, ...lines.slice(1).map(line => `${indent}  ${line.trimStart()}`)];
    });
  }
  return [`${indent}${String(value)}`];
}

/** Human-readable by default; raw JSON remains available for debugging. */
export function formatOutput(value: unknown, ctx?: Pick<ExtensionContext, "sessionManager">): string {
  // Extension callbacks always receive a session context. Keeping context-less direct calls
  // JSON-compatible preserves their low-level API contract for standalone consumers.
  if (!ctx?.sessionManager?.getBranch || rawJsonOutput(ctx)) return JSON.stringify(value, null, 2);
  return plain(value).join("\n");
}
