import { Database, SQLiteError } from "bun:sqlite";

/** How long a second process waits for the lock before it gives up. */
const WAIT_MS = 500;

/**
 * The single-instance lock: an exclusive SQLite lock on `file`, held by a transaction that stays open
 * for as long as the returned connection does, so the caller must keep a reference to it. The OS drops
 * the lock when the process ends, even after kill -9, so a crash never leaves a stale lock. Undefined
 * when another process holds it.
 *
 * Two processes that start at the same moment: SQLite fails the one that would deadlock, which lets go
 * of its read lock, and the other gets the lock. (With locking_mode = EXCLUSIVE a failed process kept
 * its read lock, so both could fail and leave no broker.)
 */
export function acquireLock(file: string): Database | undefined {
  const db = new Database(file, { create: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${WAIT_MS}`);
    db.run("BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) return undefined;
    throw error;
  }
}
