import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { feedbackCategories, MAX_REPORT_BYTES, ToolFeedbackStore, type ToolFeedback } from "../lib/tool-feedback/store.ts";

const display = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Show submitted prose, not the serialized record or a title-only alert. */
export function formatToolFeedback(report: ToolFeedback): string {
  const fields: [string, string | undefined][] = [
    ["Summary", report.summary], ["Details", report.details], ["Observed", report.observed],
    ["Expected", report.expected], ["Impact", report.impact], ["Suggestion", report.suggestion],
  ];
  return [`New tool feedback for ${display(report.tool)}${report.category ? ` (${report.category})` : ""}:`,
    ...fields.filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${display(value!).replace(/\n/g, "\n  ")}`)].join("\n");
}

const parameters = Type.Object({
  tool: Type.String({ minLength: 1, maxLength: 120, description: "Tool name or tool family; use 'tooling' for a concern that spans tools." }),
  category: Type.Optional(StringEnum(feedbackCategories)),
  summary: Type.String({ minLength: 1, maxLength: 240, description: "Short description of the concern." }),
  details: Type.String({ minLength: 1, maxLength: 6144, description: "What about the tool's behavior, interface, or limits is concerning. This may describe a working tool that is confusing or awkward." }),
  observed: Type.Optional(Type.String({ maxLength: 2500, description: "What the tool did, when useful." })),
  expected: Type.Optional(Type.String({ maxLength: 2500, description: "What would have been clearer or more useful, when known." })),
  impact: Type.Optional(Type.String({ maxLength: 1200, description: "How this behavior affected the work." })),
  suggestion: Type.Optional(Type.String({ maxLength: 1800, description: "A possible improvement, if one is apparent." })),
}, { additionalProperties: false });

/** Explicit, local-only reporting. No tool calls or conversation content are collected automatically. */
export default function toolFeedback(pi: ExtensionAPI, root = () => join(getAgentDir(), "tool-feedback")) {
  const pending: ToolFeedback[] = [];
  const showPending = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    while (pending.length) {
      ctx.ui.notify(formatToolFeedback(pending[0]!), "warning");
      pending.shift();
    }
  };
  // agent_end can precede retries and queued continuations. A shutdown before
  // settlement (e.g. reload) must not silently discard feedback already saved.
  pi.on("agent_settled", (_event, ctx) => showPending(ctx));
  pi.on("session_shutdown", (_event, ctx) => showPending(ctx));
  pi.registerTool({
    name: "tool_feedback",
    label: "Tool feedback",
    description: `Record feedback about a tool's behavior, interface, limitations, or design. Use for unexpected behavior and friction even when a command completed successfully; an ordinary command failure alone is not a tool issue unless the tool itself behaved poorly. Include only details relevant to the report. Reports are saved as immutable, private JSON files under the Pi agent directory (${MAX_REPORT_BYTES / 1024} KiB maximum); nothing is sent externally and no transcript or environment details are attached automatically.`,
    promptSnippet: "Record specific feedback about a tool's behavior or design, including working behavior that is confusing or frustrating.",
    promptGuidelines: [
      "Use tool_feedback for concrete observations about a tool or tool family, including behavior that succeeded but was awkward, confusing, unexpectedly limited, or otherwise frustrating. Do not report an ordinary command failure unless the tool's own behavior is part of the concern.",
      "Describe what happened and its effect; include an expectation or improvement idea when useful. Supply only context that should be kept in the local feedback record.",
    ],
    parameters,
    async execute(_call, params, signal) {
      signal?.throwIfAborted();
      const saved = new ToolFeedbackStore(root()).save(params);
      pending.push(saved);
      return {
        content: [{ type: "text", text: `Recorded tool feedback ${saved.id} for ${saved.tool}. Local record: ${saved.path}` }],
        details: { id: saved.id, reportedAt: saved.reportedAt, tool: saved.tool, path: saved.path },
      };
    },
  });
}
