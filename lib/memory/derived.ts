import { lstatSync, opendirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const INDEX_FILE = "memory-recall-v1.sqlite";
export const INDEX_TEMP = ".memory-index-pending-";
/** Call only while holding the canonical store lock. No live builder can own these files. */
export function invalidateRecallIndex(root: string) {
  const directory = opendirSync(root); let count = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++count > 1024) throw new Error("Store directory exceeds maintenance bounds");
      if (![INDEX_FILE, `${INDEX_FILE}-journal`, `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`].includes(entry.name) &&
          !/^\.memory-index-pending-[a-f0-9-]{36}(?:-journal|-wal|-shm)?$/.test(entry.name)) continue;
      const path = join(root, entry.name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Derived memory files must be regular, non-symlink files");
      unlinkSync(path);
    }
  } finally { directory.closeSync(); }
}
