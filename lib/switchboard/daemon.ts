import { serve } from "./server.ts";

// Started under flock by the client, never imported by the Pi extension.
process.umask(0o077);
const [root, socket] = process.argv.slice(2);
if (!root || !socket) throw new Error("Expected state directory and socket path.");
const board = await serve({ root, socket }, { staleSocket: true });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await board.close(); }
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
// Independent of any Pi lifetime, but don't keep an unused helper around forever.
let lastActive = Date.now();
const idle = setInterval(() => {
  const live = board.store.one("SELECT count(*) AS n FROM participants WHERE lease>?", Date.now())!.n;
  if (live) lastActive = Date.now();
  if (Date.now() - lastActive > 5 * 60_000) { clearInterval(idle); void stop(); }
}, 30_000);
idle.unref();
