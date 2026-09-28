import { Database } from "bun:sqlite";

/** Each entry takes the schema one version up. Later steps append (plan 2.4 onward). */
const MIGRATIONS: readonly (readonly string[])[] = [
  // 1 (plan 2.3): facts such as the Telegram offset and the paired user
  ["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"],
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

/**
 * The broker's SQLite database. The broker opens it once, and nothing else opens it. Opening migrates it
 * to SCHEMA_VERSION; a database written by a newer version of this code is refused.
 */
export class BrokerDb {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static open(file: string): BrokerDb {
    const db = new Database(file, { create: true, strict: true });
    try {
      // First, so that every statement below waits for a busy database instead of failing at once.
      db.run("PRAGMA busy_timeout = 2000");
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA foreign_keys = ON");
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new BrokerDb(db);
  }

  get schemaVersion(): number {
    return userVersion(this.#db);
  }

  getMeta(key: string): string | undefined {
    const query = this.#db.query<{ value: string }, [string]>(
      "SELECT value FROM meta WHERE key = ?",
    );
    return query.get(key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.#db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Runs `work` in one transaction: all of its writes happen, or none. */
  transaction<T>(work: () => T): T {
    return this.#db.transaction(work)();
  }

  close(): void {
    this.#db.close();
  }
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

function migrate(db: Database): void {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`broker.db has schema ${current}, newer than this code's ${SCHEMA_VERSION}`);
  }
  for (const [index, statements] of MIGRATIONS.entries()) {
    if (index < current) continue;
    db.transaction(() => {
      for (const statement of statements) db.run(statement);
      db.run(`PRAGMA user_version = ${index + 1}`);
    })();
  }
}
