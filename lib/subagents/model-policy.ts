import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickModel } from "../model-picker.ts";
import { modelRef } from "./models.ts";

export const SUBAGENT_MODEL_POLICY_ENTRY = "generalist:subagent-model-policy-v1";
export type ForcedSubagentModel = string | null;

export function normalizeForcedSubagentModel(value: unknown): ForcedSubagentModel {
  if (value === null || value === "off") return null;
  if (value === "self" || value === "same") return "self";
  if (value === "next-smaller") return value;
  if (typeof value !== "string") throw new Error("Subagent model lock must be off, self, next-smaller, or an exact provider/model ID.");
  modelRef(value);
  return value;
}

export function forcedSubagentModel(ctx: ExtensionContext): ForcedSubagentModel {
  let selected: ForcedSubagentModel = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_MODEL_POLICY_ENTRY) continue;
    try { selected = normalizeForcedSubagentModel(entry.data); }
    catch { selected = null; }
  }
  return selected;
}

export function forcedSubagentModelLabel(ctx: ExtensionContext): string {
  return forcedSubagentModel(ctx) ?? "off";
}

export function setForcedSubagentModel(pi: ExtensionAPI, value: unknown): ForcedSubagentModel {
  const normalized = normalizeForcedSubagentModel(value);
  pi.appendEntry(SUBAGENT_MODEL_POLICY_ENTRY, normalized);
  return normalized;
}

export async function configureForcedSubagentModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) throw new Error("Subagent model lock configuration requires TUI or RPC UI");
  const models = ctx.modelRegistry.getAll();
  const items = [
    { value: "off", label: "Off", description: "The agent may choose any supported subagent model specifier." },
    { value: "self", label: "self", description: "Force every new worker to use the parent model." },
    { value: "next-smaller", label: "next-smaller", description: "Force the immediate successor in the configured model ladder; never skip or fall back." },
    ...models.map((model, i) => ({ value: `model:${i}`, label: `${model.provider}/${model.id}`, description: `Force exact model · ${model.name}` })),
  ];
  const choice = ctx.mode === "tui"
    ? await pickModel(ctx, items)
    : await ctx.ui.select("Force subagent model", items.map(item => item.label))
      .then(label => items.find(item => item.label === label)?.value);
  if (choice === undefined) return;
  const model = choice.startsWith("model:") ? models[Number(choice.slice(6))] : undefined;
  if (choice.startsWith("model:") && !model) throw new Error("Invalid subagent model selection");
  const selected = setForcedSubagentModel(pi, model ? `${model.provider}/${model.id}` : choice);
  ctx.ui.notify(selected ? `Subagent model locked to ${selected}. The agent cannot override it.` : "Subagent model lock: off.", "info");
}
