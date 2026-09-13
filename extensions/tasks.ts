import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type TaskStatus = "pending" | "in_progress" | "completed";
export interface TaskItem { step: string; status: TaskStatus }
export interface TaskState { explanation?: string; plan: TaskItem[] }

export const TASK_STATE_ENTRY = "generalist:tasks:state-v1";
const MAX_TASKS = 50;

const TaskItemSchema = Type.Object({
  step: Type.String({ minLength: 1, maxLength: 500, description: "A concise task step." }),
  status: StringEnum(["pending", "in_progress", "completed"] as const, { description: "Current step status." }),
}, { additionalProperties: false });

const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String({ maxLength: 2000, description: "Brief reason for this plan update." })),
  plan: Type.Array(TaskItemSchema, { maxItems: MAX_TASKS, description: "The complete replacement task list, in execution order." }),
}, { additionalProperties: false });

function copyState(state: TaskState): TaskState {
  return { explanation: state.explanation, plan: state.plan.map(item => ({ ...item })) };
}

export function validateTaskState(input: TaskState): TaskState {
  const plan = input.plan.map(item => ({ step: item.step.trim(), status: item.status }));
  if (plan.some(item => !item.step)) throw new Error("Task steps must not be empty.");
  if (plan.filter(item => item.status === "in_progress").length > 1) {
    throw new Error("At most one task may be in_progress.");
  }
  return { explanation: input.explanation?.trim() || undefined, plan };
}

function stateFromDetails(details: unknown): TaskState | undefined {
  if (!details || typeof details !== "object") return;
  const candidate = (details as { state?: unknown }).state;
  if (!candidate || typeof candidate !== "object" || !Array.isArray((candidate as TaskState).plan)) return;
  try { return validateTaskState(candidate as TaskState); } catch { return; }
}

function icon(status: TaskStatus): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "▶" : "○";
}

function plainPlan(state: TaskState): string {
  if (!state.plan.length) return "No tasks.";
  return state.plan.map((item, index) => `${index + 1}. ${icon(item.status)} [${item.status}] ${item.step}`).join("\n");
}

export default function tasks(pi: ExtensionAPI) {
  let state: TaskState = { plan: [] };

  const updateUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!state.plan.length) {
      ctx.ui.setStatus("generalist-tasks", undefined);
      ctx.ui.setWidget("generalist-tasks", undefined);
      return;
    }
    const completed = state.plan.filter(item => item.status === "completed").length;
    ctx.ui.setStatus("generalist-tasks", `tasks: ${completed}/${state.plan.length}`);
    const shown = state.plan.slice(0, 8).map(item => {
      const color = item.status === "completed" ? "dim" : item.status === "in_progress" ? "accent" : "muted";
      return ctx.ui.theme.fg(color, `${icon(item.status)} ${item.step}`);
    });
    if (state.plan.length > shown.length) shown.push(ctx.ui.theme.fg("dim", `… ${state.plan.length - shown.length} more`));
    ctx.ui.setWidget("generalist-tasks", shown);
  };

  const restore = (ctx: ExtensionContext) => {
    state = { plan: [] };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === TASK_STATE_ENTRY) {
        const restored = stateFromDetails({ state: entry.data });
        if (restored) state = restored;
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "update_plan") {
        const restored = stateFromDetails(entry.message.details);
        if (restored) state = restored;
      }
    }
    updateUi(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: "update_plan",
    label: "Update plan",
    description: "Replace the current task checklist atomically. Each step is pending, in_progress, or completed; at most one may be in_progress. Send the complete list on every update. An empty list clears it.",
    promptSnippet: "Create or update the branch-local task checklist for multi-step work.",
    promptGuidelines: [
      "Use update_plan for meaningful multi-step work, not trivial requests; keep its statuses current and never mark more than one step in_progress.",
    ],
    parameters: UpdatePlanSchema,
    executionMode: "sequential",
    async execute(_call, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      state = validateTaskState({ explanation: params.explanation, plan: params.plan as TaskItem[] });
      updateUi(ctx);
      return {
        content: [{ type: "text", text: state.plan.length ? `Plan updated.\n${plainPlan(state)}` : "Plan cleared." }],
        details: { state: copyState(state) },
      };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.plan) ? args.plan.length : 0;
      return new Text(theme.fg("toolTitle", theme.bold("update_plan ")) + theme.fg("muted", `${count} step${count === 1 ? "" : "s"}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const restored = stateFromDetails(result.details);
      if (!restored) return new Text(theme.fg("error", "Invalid task state"), 0, 0);
      if (!restored.plan.length) return new Text(theme.fg("success", "✓ Plan cleared"), 0, 0);
      const done = restored.plan.filter(item => item.status === "completed").length;
      const current = restored.plan.find(item => item.status === "in_progress");
      let text = theme.fg("success", `✓ Plan updated · ${done}/${restored.plan.length} complete`);
      if (current) text += `\n${theme.fg("accent", "▶ ")}${theme.fg("muted", current.step)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("tasks", {
    description: "Show the task checklist, or clear it with /tasks clear",
    getArgumentCompletions: prefix => "clear".startsWith(prefix) ? [{ value: "clear", label: "clear" }] : null,
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "clear") {
        ctx.ui.notify("Usage: /tasks [clear]", "warning");
        return;
      }
      await ctx.waitForIdle();
      if (action === "clear") {
        state = { plan: [] };
        pi.appendEntry(TASK_STATE_ENTRY, copyState(state));
        updateUi(ctx);
        ctx.ui.notify("Task checklist cleared.", "info");
        return;
      }
      if (!ctx.hasUI) return;
      if (!state.plan.length) {
        ctx.ui.notify("No tasks.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(plainPlan(state), "info");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _keys, done) => ({
        render(width: number) {
          const lines = [theme.fg("accent", theme.bold("Tasks")), ""];
          if (state.explanation) lines.push(theme.fg("muted", state.explanation), "");
          for (const [index, item] of state.plan.entries()) {
            const color = item.status === "completed" ? "dim" : item.status === "in_progress" ? "accent" : "text";
            lines.push(theme.fg(color, `${index + 1}. ${icon(item.status)} ${item.step}`));
          }
          lines.push("", theme.fg("dim", "Enter or Escape to close"));
          return lines.map(line => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) done();
        },
      }), { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } });
    },
  });
}
