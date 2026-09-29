import type { BrokerDb } from "./db.ts";

export type InboxState = "new" | "handed" | "delivered" | "unconfirmed" | "unrouted";

/** A reply from Telegram, as the poller stores it. */
export interface IncomingReply {
  readonly updateId: number;
  readonly chatId: number;
  readonly messageId: number;
  /** The bot message it replies to, for routing (flow 4). */
  readonly replyTo: number | undefined;
  readonly text: string;
}

export interface StoredReply extends IncomingReply {
  readonly receivedAt: number;
  readonly state: InboxState;
  readonly sessionId: string | undefined;
  readonly generation: number | undefined;
}

interface Row {
  readonly update_id: number;
  readonly chat_id: number;
  readonly message_id: number;
  readonly reply_to: number | null;
  readonly text: string;
  readonly received_at: number;
  readonly state: InboxState;
  readonly session_id: string | null;
  readonly generation: number | null;
}

/** States after which nothing reads a reply's text again: it is dropped from disk. */
const SETTLED: ReadonlySet<InboxState> = new Set(["delivered", "unconfirmed", "unrouted"]);

/**
 * Replies from Telegram (flow 4, D7), stored before the offset moves on, so a crash can't lose one, and
 * keyed by update_id, so an update Telegram sends again is stored once. A reply is new until it is
 * routed: handed to a waiter, then delivered, or unconfirmed (its waiter never confirmed), or unrouted.
 */
export class Inbox {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Stores the reply, unless its update is there already; whether it is new. */
  store(reply: IncomingReply): boolean {
    const changed = this.#db.run(
      `INSERT OR IGNORE INTO inbox (update_id, chat_id, message_id, reply_to, text, received_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'new')`,
      reply.updateId,
      reply.chatId,
      reply.messageId,
      reply.replyTo ?? null,
      reply.text,
      this.#now(),
    );
    return changed === 1;
  }

  get(updateId: number): StoredReply | undefined {
    const row = this.#db.get<Row>("SELECT * FROM inbox WHERE update_id = ?", updateId);
    return row === undefined ? undefined : fromRow(row);
  }

  /** Replies stored but never routed: a crash came between storing and routing. */
  unrouted(): StoredReply[] {
    return this.#db
      .all<Row>("SELECT * FROM inbox WHERE state = 'new' ORDER BY update_id")
      .map(fromRow);
  }

  /** Records where the reply went. Its text goes once it is settled. */
  mark(
    updateId: number,
    state: InboxState,
    to?: { readonly sessionId: string; readonly generation: number },
  ): void {
    this.#db.run(
      `UPDATE inbox SET state = ?, session_id = coalesce(?, session_id),
         generation = coalesce(?, generation), text = CASE WHEN ? THEN '' ELSE text END
       WHERE update_id = ?`,
      state,
      to?.sessionId ?? null,
      to?.generation ?? null,
      SETTLED.has(state),
      updateId,
    );
  }
}

function fromRow(row: Row): StoredReply {
  return {
    updateId: row.update_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    replyTo: row.reply_to ?? undefined,
    text: row.text,
    receivedAt: row.received_at,
    state: row.state,
    sessionId: row.session_id ?? undefined,
    generation: row.generation ?? undefined,
  };
}
