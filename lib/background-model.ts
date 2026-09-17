import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validBackgroundModel, type BackgroundModel } from "./generalist-config.ts";
import { pickModel } from "./model-picker.ts";

export const BACKGROUND_MODEL_ENTRY = "generalist:background-model-v1";

/** Configuration only. No registry fallback, inference, or consumer activation. */
export function backgroundModel(ctx: ExtensionContext): BackgroundModel | null {
  let selected: BackgroundModel | null = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === BACKGROUND_MODEL_ENTRY) {
      selected = validBackgroundModel(entry.data) ? { ...entry.data } : null;
    }
  }
  return selected;
}

export function backgroundModelLabel(ctx: ExtensionContext): string {
  const selected = backgroundModel(ctx);
  return selected ? `${selected.provider}/${selected.model}` : "not configured";
}

export async function configureBackgroundModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) throw new Error("Background model configuration requires TUI or RPC UI");
  // Inspect the existing catalogue only: no refresh, auth resolution, or endpoint probes.
  const models = ctx.modelRegistry.getAll();
  const items = [
    { value: "clear", label: "Not configured", description: "Clear this branch's background model; no foreground fallback." },
    ...models.map((model, i) => ({ value: String(i), label: `${model.provider}/${model.id}`, description: model.name })),
  ];
  ctx.ui.notify(`Small/background model: ${backgroundModelLabel(ctx)}. Configuration only; nothing uses it yet. Ctrl+S in /generalist saves it for new sessions.`, "info");
  const choice = ctx.mode === "tui"
    ? await pickModel(ctx, items)
    : await ctx.ui.select("Small/background model (configuration only)", items.map(item => item.label))
      .then(label => items.find(item => item.label === label)?.value);
  if (choice === undefined) return;
  const model = choice === "clear" ? undefined : models[Number(choice)];
  if (choice !== "clear" && !model) throw new Error("Invalid background model selection");
  pi.appendEntry(BACKGROUND_MODEL_ENTRY, model ? { provider: model.provider, model: model.id } : null);
  ctx.ui.notify(`Small/background model: ${backgroundModelLabel(ctx)}. No consumers enabled.`, "info");
}
