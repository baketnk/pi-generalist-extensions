import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { BODY_BYTES, LEASE_MS, hash, plain, secret, text, type Card, type Mail, type Snapshot } from "./shared.ts";

const DAY = 86_400_000;
type Row = Record<string, any>;
export class BoardError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
function only(obj: Row, keys: string[]) { for (const key of Object.keys(obj)) if (!keys.includes(key)) throw new BoardError(`Unexpected field: ${key}`); }
function cardInput(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoardError("card is required.");
  const c = value as Row;
  only(c, ["name", "summary", "project", "worktree", "cwd", "activity"]);
  const result: Row = { name: plain(text(c.name, "name", 160)), summary: c.summary === "" ? "" : plain(text(c.summary, "summary", 480, true)) };
  for (const key of ["project", "worktree", "cwd"]) {
    result[key] = text(c[key], key, 4096);
    if (!isAbsolute(result[key]) || /[\x00-\x1f]/.test(result[key])) throw new BoardError(`Invalid ${key}.`);
  }
  if (!["idle", "working", "waiting-for-user", "unknown"].includes(c.activity)) throw new BoardError("Invalid activity.");
  result.activity = c.activity;
  return result;
}

/** One writer, SQLite-backed correspondence. Secrets are hashed; bodies never appear in directory/events. */
export class BoardStore {
  db: DatabaseSync;
  now: () => number;
  constructor(path: string, now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
        runtime TEXT, lease INTEGER NOT NULL DEFAULT 0, card TEXT NOT NULL,
        updated INTEGER NOT NULL, created INTEGER NOT NULL, parent TEXT, run TEXT, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES participants(id), recipient TEXT NOT NULL REFERENCES participants(id),
        kind TEXT NOT NULL, body TEXT, replyTo TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        fetchedAt INTEGER, ackAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbox ON messages(recipient,createdAt);
      CREATE TABLE IF NOT EXISTS operations (
        sender TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(sender,key)
      ); PRAGMA user_version=1;`);
    // A new daemon has no live attachments, irrespective of old wall-clock leases.
    this.db.exec("UPDATE participants SET lease=0,runtime=NULL");
  }
  close() { this.db.close(); }
  one(sql: string, ...args: any[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  all(sql: string, ...args: any[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  prune() {
    const now = this.now();
    this.transaction(() => {
      this.run("UPDATE messages SET body=NULL WHERE expiresAt<=? OR (ackAt IS NOT NULL AND ackAt<=?)", now, now - DAY);
      this.run("DELETE FROM operations WHERE created<?", now - 14 * DAY);
      this.run("DELETE FROM messages WHERE createdAt<?", now - 14 * DAY);
      this.run(`DELETE FROM participants WHERE lease<=? AND updated<? AND id NOT IN (SELECT sender FROM messages UNION SELECT recipient FROM messages)
        AND id NOT IN (SELECT parent FROM participants WHERE parent IS NOT NULL)`, now, now - 30 * DAY);
    });
  }
  auth(token: string): Row {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BoardError("Invalid credential.", 401);
    const row = this.one("SELECT * FROM participants WHERE token=? AND archived=0", hash(token));
    if (!row) throw new BoardError("Unknown/revoked credential.", 401);
    return row;
  }
  owner(token: string, runtime: unknown): Row {
    const row = this.auth(token);
    if (typeof runtime !== "string" || row.runtime !== runtime || row.lease <= this.now()) throw new BoardError("Attachment expired or superseded; reconnect.", 409);
    return row;
  }
  public(row: Row): Card {
    return { ...JSON.parse(row.card), id: row.id, type: row.type, online: row.lease > this.now(), updatedAt: row.updated,
      ...(row.parent ? { parentId: row.parent, runId: row.run } : {}) } as Card;
  }
  connect(token: string, data: Row): Card {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BoardError("Invalid credential.", 401);
    only(data, ["runtime", "card", "type"]);
    const runtime = text(data.runtime, "runtime", 128), card = cardInput(data.card);
    const type = data.type ?? "agent";
    if (!["agent", "human", "observer"].includes(type)) throw new BoardError("Invalid participant type.");
    return this.transaction(() => {
      let row = this.one("SELECT * FROM participants WHERE token=?", hash(token));
      if (row?.archived) throw new BoardError("Archived mailbox.", 410);
      if (row && row.type !== type) throw new BoardError("Participant type cannot change.");
      if (row?.runtime && row.runtime !== runtime && row.lease > this.now()) throw new BoardError("Mailbox already attached to another runtime.", 409);
      const encoded = JSON.stringify(card), now = this.now();
      if (!row) {
        if (this.one("SELECT count(*) AS n FROM participants")!.n >= 1000) throw new BoardError("Participant quota reached.", 429);
        const pid = id("p");
        this.run("INSERT INTO participants(id,token,type,card,updated,created) VALUES(?,?,?,?,?,?)", pid, hash(token), type, encoded, now, now);
        row = this.one("SELECT * FROM participants WHERE id=?", pid)!;
      }
      this.run("UPDATE participants SET runtime=?,lease=?,card=?,updated=? WHERE id=?", runtime, now + LEASE_MS, encoded, row.card === encoded ? row.updated : now, row.id);
      return this.public(this.one("SELECT * FROM participants WHERE id=?", row.id)!);
    });
  }
  heartbeat(token: string, runtime: unknown, input?: unknown): Card {
    const row = this.owner(token, runtime), card = input === undefined ? row.card : JSON.stringify(cardInput(input));
    this.run("UPDATE participants SET lease=?,card=?,updated=? WHERE id=?", this.now() + LEASE_MS, card, card === row.card ? row.updated : this.now(), row.id);
    return this.public(this.one("SELECT * FROM participants WHERE id=?", row.id)!);
  }
  detach(token: string, runtime: unknown) {
    const row = this.auth(token);
    // A late detach from an old runtime must never detach its replacement.
    this.run("UPDATE participants SET runtime=NULL,lease=0 WHERE id=? AND runtime=?", row.id, String(runtime));
    return { detached: true };
  }
  provision(token: string, runtime: unknown, runId: unknown): { id: string; token: string } {
    const parent = this.owner(token, runtime);
    if (parent.type !== "agent" || parent.parent) throw new BoardError("Only a top-level agent adapter may provision workers.", 403);
    const run = text(runId, "runId", 128);
    if (this.one("SELECT count(*) AS n FROM participants WHERE parent=? AND archived=0", parent.id)!.n >= 16) throw new BoardError("Worker quota reached.", 429);
    if (this.one("SELECT count(*) AS n FROM participants")!.n >= 1000) throw new BoardError("Participant quota reached.", 429);
    if (this.one("SELECT id FROM participants WHERE parent=? AND run=?", parent.id, run)) throw new BoardError("Run already provisioned; don't retry as a new attempt.", 409);
    const pid = id("p"), key = secret();
    this.run("INSERT INTO participants(id,token,type,card,updated,created,parent,run) VALUES(?,?,?,?,?,?,?,?)", pid, hash(key), "agent", parent.card, this.now(), this.now(), parent.id, run);
    return { id: pid, token: key };
  }
  archive(token: string, runtime: unknown) {
    const row = this.owner(token, runtime);
    this.run("UPDATE participants SET archived=1,lease=0,runtime=NULL WHERE id=?", row.id);
    return { archived: true };
  }
  snapshot(token: string, project?: string, all = false): Snapshot {
    const actor = this.auth(token), scope = project ?? JSON.parse(actor.card).project;
    const peers = this.all("SELECT * FROM participants WHERE archived=0 AND type='agent' AND id<>? ORDER BY id", actor.id)
      .filter(row => row.lease > this.now() && (all || JSON.parse(row.card).project === scope));
    const inbox = this.all("SELECT id,sender,recipient,kind,createdAt,expiresAt,replyTo,fetchedAt,ackAt FROM messages WHERE recipient=? AND ackAt IS NULL AND expiresAt>? ORDER BY createdAt,id LIMIT 128", actor.id, this.now()) as Mail[];
    const view = { peers: peers.slice(0, 64).map(row => this.public(row)), total: peers.length, inbox: inbox.slice(0, 64), pending: inbox.length };
    return { ...view, version: hash(JSON.stringify(view)) };
  }
  inspect(token: string, pid: unknown): Card {
    this.auth(token);
    const row = this.one("SELECT * FROM participants WHERE id=? AND archived=0", text(pid, "id", 64));
    if (!row) throw new BoardError("Unknown participant.", 404);
    return this.public(row);
  }
  send(token: string, runtime: unknown, data: Row): Mail {
    const actor = this.owner(token, runtime);
    if (actor.type === "observer") throw new BoardError("Observer cannot send.", 403);
    only(data, ["recipient", "kind", "body", "replyTo", "key", "ttlSeconds"]);
    const body = text(data.body, "body", BODY_BYTES), key = text(data.key, "key", 128);
    const recipient = text(data.recipient, "recipient", 64);
    const kind = data.kind ?? "note";
    if (!["note", "question", "reply", "handoff"].includes(kind)) throw new BoardError("Invalid kind.");
    const ttl = data.ttlSeconds ?? (kind === "handoff" ? 7 * 86400 : 86400);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 7 * 86400) throw new BoardError("ttlSeconds must be 1..604800.");
    const replyTo = data.replyTo === undefined ? null : text(data.replyTo, "replyTo", 64);
    if (kind === "reply" && !replyTo) throw new BoardError("Replies require replyTo.");
    const digest = hash(JSON.stringify({ recipient, kind, body, replyTo, ttl }));
    return this.transaction(() => {
      const prior = this.one("SELECT * FROM operations WHERE sender=? AND key=?", actor.id, key);
      if (prior) {
        if (prior.digest !== digest) throw new BoardError("Request key reused with different content.", 409);
        return this.message(actor.id, prior.message, false);
      }
      const target = this.one("SELECT * FROM participants WHERE id=? AND archived=0 AND type<>'observer'", recipient);
      if (!target) throw new BoardError("Unknown/archived/non-addressable recipient.", 404);
      if (replyTo) {
        const original = this.message(actor.id, replyTo, false);
        if (original.recipient !== actor.id || original.sender !== recipient) throw new BoardError("Reply must address the original sender from its recipient.", 403);
      }
      if (this.one("SELECT count(*) AS n FROM messages WHERE recipient=? AND ackAt IS NULL AND expiresAt>?", recipient, this.now())!.n >= 128 ||
          this.one("SELECT count(*) AS n FROM messages")!.n >= 4000 ||
          this.one("SELECT count(*) AS n FROM messages WHERE sender=? AND createdAt>?", actor.id, this.now() - 60_000)!.n >= 30) throw new BoardError("Mailbox/service/send-rate quota reached.", 429);
      const mid = id("m");
      this.run("INSERT INTO messages(id,sender,recipient,kind,body,replyTo,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?)", mid, actor.id, recipient, kind, body, replyTo, this.now(), this.now() + ttl * 1000);
      this.run("INSERT INTO operations VALUES(?,?,?,?,?)", actor.id, key, digest, mid, this.now());
      return this.message(actor.id, mid, false);
    });
  }
  message(actor: string, mid: unknown, body: boolean): Mail {
    const row = this.one("SELECT * FROM messages WHERE id=?", text(mid, "id", 64));
    if (!row || (row.sender !== actor && row.recipient !== actor)) throw new BoardError("Message unavailable to this participant.", 404);
    if (!body) delete row.body;
    else if (row.expiresAt <= this.now()) row.body = null;
    return row as Mail;
  }
  read(token: string, runtime: unknown, mid: unknown, body: boolean): Mail {
    const actor = this.owner(token, runtime);
    const row = this.message(actor.id, mid, body);
    if (body && row.recipient === actor.id && row.body !== null) this.run("UPDATE messages SET fetchedAt=COALESCE(fetchedAt,?) WHERE id=?", this.now(), row.id);
    return this.message(actor.id, mid, body);
  }
  ack(token: string, runtime: unknown, mid: unknown): Mail {
    const actor = this.owner(token, runtime), row = this.message(actor.id, mid, false);
    if (row.recipient !== actor.id) throw new BoardError("Only the recipient can acknowledge.", 403);
    this.run("UPDATE messages SET ackAt=COALESCE(ackAt,?) WHERE id=?", this.now(), row.id);
    return this.message(actor.id, mid, false);
  }
}
