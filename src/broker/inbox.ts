import type { BrokerDb } from "./db.ts";

export type InboxState =
  | "new"
  | "choosing"
  | "queued"
  | "handed"
  | "delivered"
  | "unconfirmed"
  | "unrouted";

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

/** A waiter: the session and generation a reply was handed to. */
interface Target {
  readonly sessionId: string;
  readonly generation: number;
}

/** States after which nothing reads a reply's text again: it is dropped from disk. */
const SETTLED: ReadonlySet<InboxState> = new Set(["delivered", "unconfirmed", "unrouted"]);

/**
 * Replies from Telegram (flow 4, D7), stored before the offset moves on, so a crash can't lose one, and
 * keyed by update_id, so an update Telegram sends again is stored once. A reply is new until it is
 * routed: choosing (the bot asked which session), queued (its session is busy), handed to a waiter with
 * the session's other queued replies, then delivered, or unconfirmed (never confirmed), or unrouted.
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

  /** Replies in `state`, oldest first; for one session, if given. */
  inState(state: InboxState, sessionId?: string): StoredReply[] {
    const bySession = sessionId === undefined ? "" : " AND session_id = ?";
    const params = sessionId === undefined ? [state] : [state, sessionId];
    return this.#db
      .all<Row>(`SELECT * FROM inbox WHERE state = ?${bySession} ORDER BY update_id`, ...params)
      .map(fromRow);
  }

  /** The replies handed to one waiter together (its session's queue and the latest), oldest first. */
  handedTo(to: Target): StoredReply[] {
    return this.#db
      .all<Row>(
        `SELECT * FROM inbox WHERE state = 'handed' AND session_id = ? AND generation = ?
         ORDER BY update_id`,
        to.sessionId,
        to.generation,
      )
      .map(fromRow);
  }

  /** Settles every reply handed to that waiter: delivered, or unconfirmed. Their text goes. */
  settleHanded(to: Target, state: "delivered" | "unconfirmed"): void {
    this.#db.run(
      `UPDATE inbox SET state = ?, text = '' WHERE state = 'handed' AND session_id = ?
       AND generation = ?`,
      state,
      to.sessionId,
      to.generation,
    );
  }

  /** Records where the reply went. Its text goes once it is settled. */
  mark(
    updateId: number,
    state: InboxState,
    to?: { readonly sessionId: string; readonly generation?: number },
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
