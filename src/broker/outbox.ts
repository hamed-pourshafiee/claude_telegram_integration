import type { BrokerDb } from "./db.ts";

/** What a bot message came from: a session's notice of some kind, in one generation. */
export interface Link {
  readonly sessionId: string;
  readonly generation: number;
  /** finish, permission, question, failure. */
  readonly kind: string;
}

interface Row {
  readonly session_id: string;
  readonly generation: number;
  readonly kind: string;
}

/** How long a notice stays linked: a reply-to an older one is taken as a plain message. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The bot's notices by chat and message id (flow 4), so that a reply-to finds its session. */
export class Outbox {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  link(chatId: number, messageId: number, link: Link): void {
    this.#db.run(
      `INSERT OR REPLACE INTO outbox (chat_id, message_id, session_id, generation, kind, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      chatId,
      messageId,
      link.sessionId,
      link.generation,
      link.kind,
      this.#now(),
    );
  }

  find(chatId: number, messageId: number): Link | undefined {
    const row = this.#db.get<Row>(
      "SELECT session_id, generation, kind FROM outbox WHERE chat_id = ? AND message_id = ?",
      chatId,
      messageId,
    );
    return row === undefined
      ? undefined
      : { sessionId: row.session_id, generation: row.generation, kind: row.kind };
  }

  /** Forgets notices older than a week; how many. */
  prune(): number {
    return this.#db.run("DELETE FROM outbox WHERE sent_at < ?", this.#now() - KEEP_MS);
  }
}
