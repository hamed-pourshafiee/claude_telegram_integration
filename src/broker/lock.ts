import { Database, SQLiteError } from "bun:sqlite";

/**
 * The single-instance lock: an exclusive SQLite lock on `file`, held for as long as the returned
 * connection stays open, so the caller must keep a reference to it. The OS drops the lock when the
 * process ends, even after kill -9, so a crash never leaves a stale lock. Undefined when another process
 * holds it.
 */
export function acquireLock(file: string): Database | undefined {
  const db = new Database(file, { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER, since TEXT)");
    db.query("INSERT OR REPLACE INTO holder (id, pid, since) VALUES (1, ?, ?)").run(
      process.pid,
      new Date().toISOString(),
    );
    return db;
  } catch (error) {
    db.close();
    if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) return undefined;
    throw error;
  }
}
