import type { BrokerDb } from "./db.ts";

/** A question /new asked: the folder a reply to it starts a session in (D11, plan 7.7). */
export interface Start {
  readonly chatId: number;
  readonly messageId: number;
  readonly projectDir: string;
  readonly askedAt: number;
  /** Open until a reply starts the session, once; or expired. */
  readonly state: "open" | "used" | "expired";
}

interface Row {
  readonly chat_id: number;
  readonly message_id: number;
  readonly project_dir: string;
  readonly asked_at: number;
  readonly state: Start["state"];
}

/** How long a /new question takes a reply. */
export const START_MS = 30 * 60_000;
/** How long a question is kept, for a late reply to be told it expired. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The questions /new asked, by chat and message id (schema 9). */
export class Starts {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  record(chatId: number, messageId: number, projectDir: string): void {
    this.#db.run(
      `INSERT OR REPLACE INTO starts (chat_id, message_id, project_dir, asked_at, state)
       VALUES (?, ?, ?, ?, 'open')`,
      chatId,
      messageId,
      projectDir,
      this.#now(),
    );
  }

  find(chatId: number, messageId: number): Start | undefined {
    const row = this.#db.get<Row>(
      "SELECT * FROM starts WHERE chat_id = ? AND message_id = ?",
      chatId,
      messageId,
    );
    return row === undefined ? undefined : fromRow(row);
  }

  /**
   * Takes the question for the reply that starts its session: whether it was open and fresh. A second
   * reply, or one after START_MS, starts nothing.
   */
  use(start: Pick<Start, "chatId" | "messageId">): "used" | "expired" | "taken" {
    const { chatId, messageId } = start;
    return this.#db.transaction(() => {
      const found = this.find(chatId, messageId);
      if (found?.state !== "open") return "taken";
      const state = this.#now() - found.askedAt < START_MS ? "used" : "expired";
      this.#db.run(
        "UPDATE starts SET state = ? WHERE chat_id = ? AND message_id = ?",
        state,
        chatId,
        messageId,
      );
      return state;
    });
  }

  /** Forgets questions older than a week; how many. */
  prune(): number {
    return this.#db.run("DELETE FROM starts WHERE asked_at < ?", this.#now() - KEEP_MS);
  }
}

function fromRow(row: Row): Start {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    projectDir: row.project_dir,
    askedAt: row.asked_at,
    state: row.state,
  };
}
