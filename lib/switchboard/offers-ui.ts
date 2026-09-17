import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { BoardRuntime } from "./runtime.ts";
import { BODY_BYTES, plain, type Card, type Offer, type OfferPolicyRecord } from "./shared.ts";

export type OfferAction = { action: "create" | "policy" | "accept" | "decline" | "cancel" | "start" | "resolve-unknown"; id?: string };
export function taskMessage(offer: Offer): string {
  return `Human-accepted switchboard task offer ${offer.id}. The human explicitly chose to start this task in the current conversation; existing context remains. This is task delivery, not proof of completion or a grant beyond the task below.\n` +
    `Creator participant: ${offer.creator}; recipient: ${offer.recipient}; project: ${offer.project}; checkout: ${offer.worktree}.\n` +
    `Original human-authored task (preserved verbatim):\n${offer.originalTask}`;
}
/** Pi's sendUserMessage is fire-and-forget. Only an actual user message lifecycle
 * event proves delivery; synchronous return does not prove prompt preflight succeeded.
 * Pending matches are runtime-local and deliberately not restored/replayed on reload.
 */
export class OfferDeliveryTracker {
  private pending = new Map<string, { runtime: BoardRuntime; offer: Offer; current: () => boolean }>();
  send(pi: ExtensionAPI, runtime: BoardRuntime, offer: Offer, current: () => boolean) {
    const message = taskMessage(offer);
    this.pending.set(message, { runtime, offer, current });
    try { pi.sendUserMessage(message); }
    catch (error) { this.pending.delete(message); throw error; }
  }
  async observe(message: { role: string; content?: unknown }) {
    if (message.role !== "user") return;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter(c => c?.type === "text").map(c => c.text).join("") : undefined;
    if (text === undefined) return;
    const entry = this.pending.get(text);
    if (!entry) return;
    this.pending.delete(text);
    if (entry.runtime.closed || !entry.current()) return;
    await entry.runtime.requireClient().call("offer", { op: "delivered", id: entry.offer.id, generation: entry.offer.generation });
    if (!entry.runtime.closed && entry.current()) await entry.runtime.refresh();
  }
  clear() { this.pending.clear(); }
}

/** No idle hook or automatic offer delivery. Every call comes from a human command/control. */
export async function actOnOffer(pi: ExtensionAPI, ctx: ExtensionContext, r: BoardRuntime, request: OfferAction, current: () => boolean, delivery: OfferDeliveryTracker) {
  const guard = () => { if (!current() || r.closed) throw new Error("Session changed; offer action cancelled."); r.requireClient(); };
  guard();
  const client = r.requireClient();
  if (request.action === "create") {
    const snapshot = await r.refresh(); guard();
    const choices = snapshot.peers.map(c => `${plain(c.handle)} · ${plain(c.name)} · ${plain(c.model || "model not reported")} · ${plain(c.worktree)}`);
    choices.push("Enter exact ID/handle (including offline queue recipients)");
    const selected = await ctx.ui.select("Offer a task — recipient must explicitly accept", choices); guard();
    if (!selected) return;
    const candidate = snapshot.peers[choices.indexOf(selected)];
    const recipient = candidate?.id ?? await ctx.ui.input("Exact participant ID/handle — no name guessing or worker launch"); guard();
    if (!recipient) return;
    const policy = await client.call<OfferPolicyRecord & { card: Card }>("offer", { op: "policy-get", recipient }); guard();
    if (policy.policy === "off") throw new Error("Recipient has disabled task offers.");
    const originalTask = await ctx.ui.editor(`Original human task for ${plain(policy.card.handle)} (no model decomposition)`, ""); guard();
    if (originalTask === undefined || !originalTask.trim()) return;
    if (Buffer.byteLength(originalTask) > BODY_BYTES) throw new Error("Task exceeds 16 KiB UTF-8.");
    const confirmed = await ctx.ui.confirm("Create task offer?", `Recipient: ${plain(policy.card.handle)}\nCheckout: ${plain(policy.card.worktree)}\nPolicy: ${policy.policy}; generation ${policy.generation}\nExpires in 24 hours. No model call, execution, or session replacement occurs. Recipient acceptance and start are separate human actions.`); guard();
    if (!confirmed) return;
    const result = await client.createOffer(`human-offer:${randomUUID()}`, { recipient: policy.card.id, worktree: policy.card.worktree, originalTask, generation: policy.generation, authority: "human-ui" }); guard();
    ctx.ui.notify(`Offered ${result.id}; not accepted or started.`, "info");
  } else if (request.action === "policy") {
    const policy = await client.call<OfferPolicyRecord>("offer", { op: "policy-get", recipient: r.card!.id }); guard();
    const choices = ["manual — human acceptance; offers only while online", "queue — allow offline offers; still human acceptance/start", "off — reject offers and prevent acceptance/start"];
    const selected = await ctx.ui.select(`Task offer policy (currently ${policy.policy})`, choices); guard();
    if (!selected) return;
    await client.call("offer", { op: "policy-set", policy: ["manual", "queue", "off"][choices.indexOf(selected)], generation: policy.generation }); guard();
  } else {
    const offer = await client.call<Offer>("offer", { op: "inspect", id: request.id }); guard();
    if (request.action === "start") {
      const idle = () => { guard(); if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Session has active or queued work. Start remains deferred; wait for it to settle and choose Start again."); };
      idle();
      if (offer.state !== "accepted") throw new Error("Accept the offer first. Acceptance alone never starts a model.");
      if (!await ctx.ui.confirm(`Start accepted task ${offer.id}?`, `Continue THIS conversation (not a new session). Existing context can influence the task.\nCheckout: ${plain(offer.worktree)}\nTask preview: ${plain(offer.originalTask).slice(0, 600)}\n\nThis explicitly starts your foreground model using its current tools/settings. No automatic commit or additional authority is implied. Delivery cannot safely be retried after an uncertain outcome.`)) return;
      idle();
      const claimed = await client.call<Offer>("offer", { op: "claim-delivery", id: offer.id, generation: offer.generation });
      // Claim is durable BEFORE crossing into Pi. A crash or rejection leaves a visible
      // uncertain claim, never permission to deliver twice on reload/new/fork/tree.
      idle();
      delivery.send(pi, r, claimed, current);
      // Delivered is recorded by message_start, never by this void API's return.
      // Preflight/auth/input interception failure leaves a visible uncertain claim.
      return;
    }
    if (request.action === "resolve-unknown") {
      if (!await ctx.ui.confirm(`Close uncertain delivery ${offer.id}?`, "First inspect this session's history and any queued prompt. This records delivery-unknown and unblocks OTHER offers; it does not replay this task, assert non-delivery, or cancel work already running.")) return;
      guard();
      await client.call("offer", { op: "resolve-unknown", id: offer.id, generation: offer.generation }); guard();
      await r.refresh(); return;
    }
    if (!await ctx.ui.confirm(`${request.action} offer ${offer.id}?`, request.action === "accept"
      ? "Accept only; this does NOT start execution. Use Start separately after inspecting the original task."
      : "This changes only the task offer, not any running model or repository.")) return;
    guard();
    await client.call("offer", { op: request.action, id: offer.id, generation: offer.generation }); guard();
  }
  await r.refresh();
}
