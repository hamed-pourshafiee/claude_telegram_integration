import { Database } from "bun:sqlite";

/** A value SQLite takes as a parameter. */
export type Binding = string | number | bigint | boolean | null;

/** Each entry takes the schema one version up. Later steps append (plan 2.4 onward). */
const MIGRATIONS: readonly (readonly string[])[] = [
  // 1 (plan 2.3): facts such as the Telegram offset and the paired user
  ["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"],
  // 2 (plan 2.7): the sessions hooks report; a stop's result counts only in its own generation
  [
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      entrypoint TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      generation INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
  ],
  // 3 (plans 3.1, 3.2): Stop hooks waiting for a reply, the replies from Telegram, stored before the
  // offset moves on (D7), and the bot's notices, so a reply-to finds its session (flow 4). Times are ms
  // since the epoch: a cancel is matched against them.
  [
    "ALTER TABLE sessions ADD COLUMN stopped_at INTEGER NOT NULL DEFAULT 0",
    `CREATE TABLE waiters (
      session_id TEXT NOT NULL REFERENCES sessions (id),
      generation INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      claude_pid INTEGER NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('waiting', 'handed', 'delivered', 'cancelled', 'ended')),
      update_id INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, generation)
    ) STRICT`,
    `CREATE TABLE inbox (
      update_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      reply_to INTEGER,
      text TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('new', 'choosing', 'queued', 'handed', 'delivered', 'unconfirmed', 'unrouted')),
      session_id TEXT,
      generation INTEGER
    ) STRICT`,
    `CREATE TABLE outbox (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    ) STRICT`,
  ],
  // 4 (plan 4.1): Claude's questions (AskUserQuestion), each asked by one waiting PreToolUse hook, and
  // the chat message of each question. `input` holds the questions as Claude wrote them, and `html` a
  // message as sent, until the question is settled (D8).
  [
    `CREATE TABLE asks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id),
      tool_use_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      claude_pid INTEGER NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('remote', 'answered', 'delivered', 'local', 'closed', 'ended')),
      input TEXT NOT NULL,
      told INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, tool_use_id)
    ) STRICT`,
    `CREATE TABLE ask_questions (
      ask_id TEXT NOT NULL REFERENCES asks (id),
      idx INTEGER NOT NULL,
      chat_id INTEGER,
      message_id INTEGER,
      html TEXT NOT NULL DEFAULT '',
      picked TEXT NOT NULL DEFAULT '[]',
      answer TEXT,
      PRIMARY KEY (ask_id, idx)
    ) STRICT`,
    "CREATE INDEX ask_messages ON ask_questions (chat_id, message_id)",
  ],
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

  /** The first row `sql` selects, or undefined. */
  get<Row>(sql: string, ...params: Binding[]): Row | undefined {
    return this.#db.query<Row, Binding[]>(sql).get(...params) ?? undefined;
  }

  /** Every row `sql` selects. */
  all<Row>(sql: string, ...params: Binding[]): Row[] {
    return this.#db.query<Row, Binding[]>(sql).all(...params);
  }

  /** Runs a statement; how many rows it changed, which tells a racing update whether it won. */
  run(sql: string, ...params: Binding[]): number {
    return this.#db.query<unknown, Binding[]>(sql).run(...params).changes;
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
