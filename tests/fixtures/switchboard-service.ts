import { join } from "node:path";
import { serve } from "../../lib/switchboard/server.ts";
process.umask(0o077);
const root = process.argv[2]!;
const board = await serve({ root, socket: join(root, "board.sock") }, { staleSocket: true });
console.log("ready");
process.once("SIGTERM", () => { void board.close(); });
