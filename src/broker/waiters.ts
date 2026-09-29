import type { BrokerDb } from "./db.ts";

export type WaiterState = "waiting" | "handed" | "delivered" | "cancelled" | "ended";

/** Which waiter: one per session and generation. */
export interface WaiterRef {
  readonly sessionId: string;
  readonly generation: number;
}

export interface Waiter extends WaiterRef {
  /** The Stop hook's process… */
  readonly pid: number;
  /** …and its parent, the Claude Code process (both checked at broker start). */
  readonly claudePid: number;
  readonly state: WaiterState;
  /** The reply handed to it. */
  readonly updateId: number | undefined;
  /** When it registered, in ms since the epoch: a cancel only reaches waiters from before it. */
  readonly createdAt: number;
}

interface Row {
  readonly session_id: string;
  readonly generation: number;
  readonly pid: number;
  readonly claude_pid: number;
  readonly state: WaiterState;
  readonly update_id: number | null;
  readonly created_at: number;
}

const BY_REF = "WHERE session_id = ? AND generation = ?";

/**
 * The Stop hooks that wait for a reply (flow 1, plan 3.1). A waiter goes from waiting to handed (a reply
 * was given to it) to delivered (it confirmed, and injects the reply now), or it stops waiting: cancelled
 * by typing at the Mac, or ended (a newer stop, its hook stopped, its Claude is gone). Handing over and
 * cancelling are each one UPDATE of a waiting row, so whichever commits first wins (flow 2).
 */
export class Waiters {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * Registers a waiter in its session's current generation, or finds it again when its hook reconnects.
   * "stale" when that generation is over (typed at the Mac, a newer stop, the session ended).
   */
  register(
    ref: WaiterRef & { readonly pid: number; readonly claudePid: number },
  ): Waiter | "stale" {
    return this.#db.transaction(() => {
      const known = this.get(ref);
      if (known !== undefined) return known;
      const session = this.#db.get<{ generation: number; ended_at: string | null }>(
        "SELECT generation, ended_at FROM sessions WHERE id = ?",
        ref.sessionId,
      );
      if (session === undefined || session.ended_at !== null) return "stale";
      if (session.generation !== ref.generation) return "stale";
      this.#db.run(
        `INSERT INTO waiters (session_id, generation, pid, claude_pid, state, created_at)
         VALUES (?, ?, ?, ?, 'waiting', ?)`,
        ref.sessionId,
        ref.generation,
        ref.pid,
        ref.claudePid,
        this.#now(),
      );
      return this.get(ref) ?? "stale";
    });
  }

  get(ref: WaiterRef): Waiter | undefined {
    const row = this.#db.get<Row>(`SELECT * FROM waiters ${BY_REF}`, ref.sessionId, ref.generation);
    return row === undefined ? undefined : fromRow(row);
  }

  /** Who a reply can go to: waiting, in the current generation of a session that hasn't ended. */
  listening(): Waiter[] {
    return this.#db
      .all<Row>(
        `SELECT w.* FROM waiters w JOIN sessions s ON s.id = w.session_id
         WHERE w.state = 'waiting' AND w.generation = s.generation AND s.ended_at IS NULL
         ORDER BY w.created_at`,
      )
      .map(fromRow);
  }

  /** Gives it a reply, if it is still waiting; whether it was. */
  handOver(ref: WaiterRef, updateId: number): boolean {
    const sql = `UPDATE waiters SET state = 'handed', update_id = ? ${BY_REF} AND state = 'waiting'`;
    return this.#db.run(sql, updateId, ref.sessionId, ref.generation) === 1;
  }

  /** It has the reply and injects it now; asked again after a reconnect, still yes. */
  confirm(ref: WaiterRef, updateId: number): boolean {
    const sql = `UPDATE waiters SET state = 'delivered' ${BY_REF} AND state = 'handed' AND update_id = ?`;
    if (this.#db.run(sql, ref.sessionId, ref.generation, updateId) === 1) return true;
    const waiter = this.get(ref);
    return waiter?.state === "delivered" && waiter.updateId === updateId;
  }

  /**
   * You typed at the Mac at `at` (flow 2). The session's waiters from before then stop waiting; one
   * that was handed a reply already keeps it (it can't be recalled), and is returned as crossed.
   */
  cancel(sessionId: string, at: number): { cancelled: Waiter[]; crossed: Waiter[] } {
    return this.#db.transaction(() => {
      const before = this.#db
        .all<Row>(
          `SELECT * FROM waiters WHERE session_id = ? AND created_at <= ?
           AND state IN ('waiting', 'handed')`,
          sessionId,
          at,
        )
        .map(fromRow);
      this.#db.run(
        `UPDATE waiters SET state = 'cancelled'
         WHERE session_id = ? AND created_at <= ? AND state = 'waiting'`,
        sessionId,
        at,
      );
      return {
        cancelled: before.filter((waiter) => waiter.state === "waiting"),
        crossed: before.filter((waiter) => waiter.state === "handed"),
      };
    });
  }

  /** The session's waiting waiters older than `generation` (a newer stop, or its end) stop waiting. */
  supersede(sessionId: string, generation: number): Waiter[] {
    return this.#db.transaction(() => {
      const older = this.#db
        .all<Row>(
          "SELECT * FROM waiters WHERE session_id = ? AND generation < ? AND state = 'waiting'",
          sessionId,
          generation,
        )
        .map(fromRow);
      this.#db.run(
        "UPDATE waiters SET state = 'ended' WHERE session_id = ? AND generation < ? AND state = 'waiting'",
        sessionId,
        generation,
      );
      return older;
    });
  }

  /**
   * Its hook stopped waiting (SIGTERM, its Claude gone). What it was before: "handed" means a reply was
   * given to it and never confirmed, so it must be reported, never resent.
   */
  end(ref: WaiterRef): WaiterState | undefined {
    return this.#db.transaction(() => {
      const waiter = this.get(ref);
      if (waiter?.state !== "waiting" && waiter?.state !== "handed") return waiter?.state;
      this.#db.run(`UPDATE waiters SET state = 'ended' ${BY_REF}`, ref.sessionId, ref.generation);
      return waiter.state;
    });
  }

  /** Waiters still waiting or handed a reply: at start, the broker checks their processes. */
  open(): Waiter[] {
    return this.#db
      .all<Row>("SELECT * FROM waiters WHERE state IN ('waiting', 'handed')")
      .map(fromRow);
  }
}

export function waiterKey(ref: WaiterRef): string {
  return `${ref.sessionId}#${ref.generation}`;
}

function fromRow(row: Row): Waiter {
  return {
    sessionId: row.session_id,
    generation: row.generation,
    pid: row.pid,
    claudePid: row.claude_pid,
    state: row.state,
    updateId: row.update_id ?? undefined,
    createdAt: row.created_at,
  };
}
