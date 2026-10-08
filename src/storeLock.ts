import { DatabaseSync } from "node:sqlite";

// A dedicated SQLite connection holds an OS-managed exclusive file lock for the
// JSON store's entire lifetime. There is no PID identity to reuse and no stale
// ownership to reclaim after a crash/reboot. Never unlink this file: every owner
// must contend on the same inode. This requires local filesystem SQLite locking.
// The old PID-only store.lock is deliberately ignored; stop the old service
// before upgrading (as the normal deployment activation does).
export function acquireStoreLock(path: string): () => void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    const code = (error as { errcode?: number }).errcode;
    if (code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6)) {
      throw new Error("Events store is already owned by another process", { cause: error });
    }
    throw error; // Permissions, corruption and unsupported locking fail closed.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    database.close(); // Rolls back the transaction and releases its kernel lock.
  };
}
