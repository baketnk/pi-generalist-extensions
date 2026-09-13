import { randomBytes } from "node:crypto";
import { BoardError, type BoardStore } from "./store.ts";
import { BODY_BYTES, hash, text, type Offer, type OfferPolicyRecord, type OfferSummary } from "./shared.ts";

const DAY = 86_400_000;
const terminal = ["declined", "cancelled", "expired", "delivered", "delivery-unknown"];
function only(data: Record<string, unknown>, fields: string[]) {
  for (const key of Object.keys(data)) if (!fields.includes(key)) throw new BoardError(`Unexpected offer field: ${key}`);
}
/** Separate human-offer protocol, never inferred from mail or presence transitions.
 * Authenticated adapter attests human UI provenance; not a same-UID security boundary.
 */
export class OfferStore {
  private store: BoardStore;
  constructor(store: BoardStore) { this.store = store; }
  initialize() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS offer_policies (
        participant TEXT PRIMARY KEY REFERENCES participants(id), policy TEXT NOT NULL, generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY, creator TEXT NOT NULL REFERENCES participants(id), recipient TEXT NOT NULL REFERENCES participants(id),
        operation TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL, created INTEGER NOT NULL,
        UNIQUE(creator,operation)
      );
      CREATE INDEX IF NOT EXISTS offer_recipient ON offers(recipient);
    `);
  }
  policy(participant: string): OfferPolicyRecord {
    const row = this.store.one("SELECT * FROM offer_policies WHERE participant=?", participant);
    return row ? row as OfferPolicyRecord : { participant, policy: "manual", generation: 0 };
  }
  private expire(offer: Offer): Offer {
    if (["offered", "accepted"].includes(offer.state) && offer.expiresAt <= this.store.now()) {
      return { ...offer, state: "expired", generation: offer.generation + 1, updatedAt: offer.expiresAt };
    }
    return offer;
  }
  private decode(record: string): Offer { return this.expire(JSON.parse(record)); }
  list(actor: string): { offers: OfferSummary[]; offerTotal: number; offerPolicy: OfferPolicyRecord } {
    const records = this.store.all("SELECT record FROM offers WHERE creator=? OR recipient=?", actor, actor).map(row => this.decode(row.record));
    const rank = (offer: Offer) => terminal.includes(offer.state) ? 2 : offer.recipient === actor ? 0 : 1;
    records.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { offers: records.slice(0, 64).map(offer => {
      const { originalTask: _task, deliveryRuntime: _runtime, ...summary } = offer; return summary;
    }), offerTotal: records.length, offerPolicy: this.policy(actor) };
  }
  private get(actor: string, id: unknown): Offer {
    const row = this.store.one("SELECT record FROM offers WHERE id=? AND (creator=? OR recipient=?)", text(id, "id", 64), actor, actor);
    if (!row) throw new BoardError("Offer unavailable to this participant.", 404);
    return this.decode(row.record);
  }
  private save(offer: Offer) { this.store.run("UPDATE offers SET record=? WHERE id=?", JSON.stringify(offer), offer.id); }
  request(token: string, runtime: unknown, data: Record<string, unknown>): unknown {
    const actor = this.store.owner(token, runtime);
    if (actor.type !== "agent") throw new BoardError("Only attached agent adapters support interactive offers.", 403);
    const action = data.op;
    if (action === "policy-get") {
      only(data, ["op", "recipient"]);
      const target = this.store.inspect(token, text(data.recipient, "recipient", 64));
      if (target.project !== JSON.parse(actor.card).project || target.type !== "agent") throw new BoardError("Offer target outside project scope.", 403);
      return { ...this.policy(target.id), card: target };
    }
    if (action === "inspect") { only(data, ["op", "id"]); return this.get(actor.id, data.id); }
    return this.store.transaction(() => {
      if (action === "policy-set") {
        only(data, ["op", "policy", "generation"]);
        if (!["manual", "queue", "off"].includes(String(data.policy))) throw new BoardError("Invalid offer policy.");
        const prior = this.policy(actor.id);
        if (prior.generation !== data.generation) throw new BoardError("Stale policy generation; refresh.", 409);
        this.store.run("INSERT INTO offer_policies VALUES(?,?,?) ON CONFLICT(participant) DO UPDATE SET policy=excluded.policy,generation=excluded.generation", actor.id, data.policy, prior.generation + 1);
        return this.policy(actor.id);
      }
      if (action === "create") {
        only(data, ["op", "recipient", "originalTask", "key", "generation", "ttlSeconds", "authority", "worktree"]);
        if (data.authority !== "human-ui") throw new BoardError("Explicit human UI authority required.", 403);
        const originalTask = text(data.originalTask, "originalTask", BODY_BYTES), reference = text(data.recipient, "recipient", 64), key = text(data.key, "key", 128);
        const ttl = data.ttlSeconds ?? 86400;
        if (!Number.isInteger(ttl) || Number(ttl) < 60 || Number(ttl) > 7 * 86400) throw new BoardError("Offer ttlSeconds must be 60..604800.");
        const worktree = text(data.worktree, "worktree", 4096);
        const digest = hash(JSON.stringify([reference, originalTask, data.generation, ttl, worktree]));
        const old = this.store.one("SELECT record,digest FROM offers WHERE creator=? AND operation=?", actor.id, key);
        if (old) {
          if (old.digest !== digest) throw new BoardError("Offer operation reused with different content.", 409);
          return this.decode(old.record);
        }
        const target = this.store.inspect(token, reference), policy = this.policy(target.id), own = JSON.parse(actor.card);
        if (target.id === actor.id || target.type !== "agent" || target.project !== own.project) throw new BoardError("Offers require another agent in the same project.", 403);
        if (target.worktree !== worktree) throw new BoardError("Candidate checkout changed; refresh and review.", 409);
        if (policy.generation !== data.generation) throw new BoardError("Stale candidate policy generation; refresh.", 409);
        if (policy.policy === "off" || (policy.policy === "manual" && !target.online)) throw new BoardError("Recipient policy or offline state rejects this offer.", 409);
        const pending = this.store.all("SELECT record FROM offers WHERE recipient=?", target.id).filter(row => !terminal.includes(this.decode(row.record).state));
        if (pending.length >= 8 || this.store.one("SELECT count(*) AS n FROM offers")!.n >= 2000 || this.store.one("SELECT count(*) AS n FROM offers WHERE creator=? AND created>?", actor.id, this.store.now() - 60_000)!.n >= 10) throw new BoardError("Offer queue/service/rate quota reached.", 429);
        const now = this.store.now();
        const offer: Offer = { id: `q_${randomBytes(8).toString("hex")}`, creator: actor.id, recipient: target.id,
          project: target.project, worktree: target.worktree, originalTask, authority: "human-ui", state: "offered", generation: 0,
          createdAt: now, updatedAt: now, expiresAt: now + Number(ttl) * 1000, policyGeneration: policy.generation };
        this.store.run("INSERT INTO offers VALUES(?,?,?,?,?,?,?)", offer.id, actor.id, target.id, key, digest, JSON.stringify(offer), now);
        return offer;
      }
      only(data, ["op", "id", "generation"]);
      const offer = this.get(actor.id, data.id), policy = this.policy(actor.id);
      if (offer.generation !== data.generation) throw new BoardError("Stale offer generation; inspect before acting.", 409);
      const next = { ...offer, generation: offer.generation + 1, updatedAt: this.store.now() };
      if (action === "cancel") {
        if (offer.creator !== actor.id || !["offered", "accepted"].includes(offer.state)) throw new BoardError("Only creator may cancel before delivery is claimed.", 409);
        next.state = "cancelled";
      } else {
        if (offer.recipient !== actor.id) throw new BoardError("Only recipient may accept, decline or deliver.", 403);
        if (action === "decline" && ["offered", "accepted"].includes(offer.state)) next.state = "declined";
        else if (action === "accept" || action === "claim-delivery") {
          if (offer.state !== (action === "accept" ? "offered" : "accepted")) throw new BoardError("Offer state does not allow this transition.", 409);
          const own = JSON.parse(actor.card);
          if (policy.policy === "off" || own.project !== offer.project || own.worktree !== offer.worktree) throw new BoardError("Recipient policy/checkout changed; decline or review a new offer.", 409);
          if (action === "claim-delivery" && this.store.all("SELECT record FROM offers WHERE recipient=?", actor.id).some(row => this.decode(row.record).state === "delivery-claimed")) throw new BoardError("An earlier delivery has an uncertain outcome; inspect it before starting more work.", 409);
          next.state = action === "accept" ? "accepted" : "delivery-claimed";
          if (action === "claim-delivery") next.deliveryRuntime = String(runtime);
        } else if (action === "resolve-unknown" && offer.state === "delivery-claimed") next.state = "delivery-unknown";
        else if (action === "delivered" && offer.state === "delivery-claimed" && offer.deliveryRuntime === runtime) next.state = "delivered";
        else throw new BoardError("Invalid offer transition; delivery claims are never automatically replayed.", 409);
      }
      this.save(next); return next;
    });
  }
  prune() {
    // Fixed 30-day operation horizon. Unresolved delivery claims stay for explicit inspection.
    for (const row of this.store.all("SELECT record FROM offers WHERE created<?", this.store.now() - 30 * DAY)) {
      const offer = this.decode(row.record);
      if (terminal.includes(offer.state)) this.store.run("DELETE FROM offers WHERE id=?", offer.id);
    }
  }
}
