import { createServer, type Server } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoardError, BoardStore } from "./store.ts";
import { VERSION, privateDir, privateFile, type Paths } from "./shared.ts";

export interface BoardServer { server: Server; store: BoardStore; close(): Promise<void> }
/** Caller must hold the daemon's exclusive flock before removing a stale socket. */
export async function serve(paths: Paths, options: { staleSocket?: boolean; now?: () => number } = {}): Promise<BoardServer> {
  await privateDir(paths.root);
  // XDG_RUNTIME_DIR itself is private; fallback directory is created private too.
  await privateDir(dirname(paths.socket));
  for (const file of ["board.sqlite", "board.sqlite-wal", "board.sqlite-shm"]) await privateFile(join(paths.root, file));
  if (options.staleSocket) await unlink(paths.socket).catch(e => { if (e.code !== "ENOENT") throw e; });
  const store = new BoardStore(join(paths.root, "board.sqlite"), options.now);
  for (const file of ["board.sqlite", "board.sqlite-wal", "board.sqlite-shm"]) await chmod(join(paths.root, file), 0o600).catch(e => { if (e.code !== "ENOENT") throw e; });
  const wake = new Set<() => void>();
  const changed = () => { for (const fn of [...wake]) fn(); };
  let closing = false;
  const server = createServer(async (req, res) => {
    const reply = (status: number, data: unknown) => {
      if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
    };
    try {
      if (closing) throw new BoardError("Service closing.", 503);
      if (req.url === "/v1/health" && req.method === "GET") { reply(200, { version: VERSION, pid: process.pid }); return; }
      if (req.url !== "/v1/rpc" || req.method !== "POST") throw new BoardError("Unknown endpoint.", 404);
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw new BoardError("Request too large.", 413); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new BoardError("Expected request object.");
      const { action, runtime, ...args } = data;
      let result: unknown;
      switch (action) {
        case "connect": result = store.connect(token, { runtime, ...args }); break;
        case "heartbeat": result = store.heartbeat(token, runtime, args.card); break;
        case "detach": result = store.detach(token, runtime); break;
        case "archive": result = store.archive(token, runtime); break;
        case "provision": result = store.provision(token, runtime, args.runId); break;
        case "inspect": result = store.inspect(token, args.id); break;
        case "send": result = store.send(token, runtime, args); break;
        case "read": result = store.read(token, runtime, args.id, true); break;
        case "status": result = store.read(token, runtime, args.id, false); break;
        case "ack": result = store.ack(token, runtime, args.id); break;
        case "snapshot": result = store.snapshot(token, args.project, args.all === true); break;
        case "watch": {
          if (wake.size >= 128) throw new BoardError("Too many subscriptions.", 429);
          result = await new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => { if (timer) clearTimeout(timer); wake.delete(check); res.off("close", closed); };
            const closed = () => { cleanup(); resolve(undefined); };
            const check = () => {
              try {
                const snapshot = store.snapshot(token, args.project, args.all === true);
                if (closing || snapshot.version !== args.since) { cleanup(); resolve(snapshot); }
              } catch (error) { cleanup(); reject(error); }
            };
            res.once("close", closed); wake.add(check);
            timer = setTimeout(() => {
              cleanup();
              try { resolve(store.snapshot(token, args.project, args.all === true)); } catch (error) { reject(error); }
            }, 25_000);
            check();
          });
          break;
        }
        default: throw new BoardError("Unknown action.");
      }
      reply(200, result ?? {});
      if (!["snapshot", "watch", "inspect", "status"].includes(action)) changed();
    } catch (error) {
      // Never log requests or arbitrary exception text (which may contain bodies).
      reply(error instanceof BoardError ? error.status : 400, { error: error instanceof BoardError ? error.message : "Invalid request or storage failure." });
    }
  });
  server.maxConnections = 160;
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, () => { server.off("error", reject); resolve(); }); });
    await chmod(paths.socket, 0o600);
  } catch (error) { server.close(); store.close(); throw error; }
  const expiry = setInterval(changed, 5000); expiry.unref();
  const prune = setInterval(() => { try { store.prune(); changed(); } catch { /* Subsequent writes still fail explicitly. */ } }, 60_000); prune.unref();
  return { server, store, async close() {
    if (closing) return; closing = true; clearInterval(expiry); clearInterval(prune); changed();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); store.close();
  } };
}
