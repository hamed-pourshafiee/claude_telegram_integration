import { basename } from "node:path";
import { messageOf } from "../shared/errors.ts";
import type { Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { readPending, removePending } from "../shared/pending.ts";
import { processAlive } from "../shared/process.ts";
import { type Answer, bad, ok } from "./answer.ts";
import type { BrokerDb } from "./db.ts";
import type { Inbox, IncomingReply } from "./inbox.ts";
import { label, type Sessions } from "./sessions.ts";
import { type Waiter, type WaiterRef, type Waiters, waiterKey } from "./waiters.ts";

export interface RelayDeps {
  readonly db: BrokerDb;
  readonly sessions: Sessions;
  readonly waiters: Waiters;
  readonly inbox: Inbox;
  /** Sends the paired user a message about their reply (not held back by presence). */
  readonly tell: (text: string) => Promise<void>;
  /** The paired user's first name, for "📨 Telegram reply from …". */
  readonly senderName: () => string | null;
  readonly log: Log;
  /** How long a Wait is held before it answers "waiting"; default 25 s. */
  readonly holdMs?: number;
  /** Whether a process runs; default: a signal-0 kill. */
  readonly alive?: (pid: number) => boolean;
  /** A waiter that typing at the Mac stopped (its ✅ says so, plan 3.3). */
  readonly onCancelled?: (waiter: Waiter) => void;
}

interface Parked {
  readonly resolve: (answer: Answer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const TEXTS = {
  crossed: (name: string) =>
    `↩️ Your message to ${name} crossed with typing at the Mac. It was already on its way, so ` +
    "Claude still gets it.",
  unconfirmed: (name: string) =>
    `⚠️ Your message to ${name} was handed over but never confirmed, so it may not have arrived. ` +
    "It wasn't sent again.",
  lostQueue: (name: string) =>
    `⚠️ ${name} ended before your queued message went in, so it wasn't delivered.`,
} as const;

/**
 * Replies from Telegram to waiting Stop hooks (flows 1, 2 and 4; plans 3.1 and 3.2). The database decides
 * every race; this class keeps the waiters' open Wait calls and answers them when there is news. A
 * session's replies go to its waiter together, and are delivered once that waiter confirms, so nothing
 * is injected twice (D7). What a crash leaves behind is sorted out by recover() at start. Which session
 * a reply is for is the router's business.
 */
export class Relay {
  readonly #deps: RelayDeps;
  readonly #parked = new Map<string, Parked>();

  constructor(deps: RelayDeps) {
    this.#deps = deps;
  }

  /** A Stop hook waits: registered, then answered at once with its queue, or when there is news. */
  wait(fields: Fields): Answer | Promise<Answer> {
    const ref = refOf(fields);
    const { pid, claude_pid: claudePid } = fields;
    if (ref === undefined || typeof pid !== "number" || typeof claudePid !== "number") {
      return bad("bad wait");
    }
    const waiter = this.#deps.waiters.register({ ...ref, pid, claudePid });
    if (waiter === "stale") return ok({ state: "stale" });
    // Replies queued while the session was busy go in at its next stop (flow 4).
    if (waiter.state === "waiting" && this.#handOver(waiter, [])) return this.#replyFor(ref);
    if (waiter.state === "waiting") return this.#park(ref);
    if (waiter.state === "handed") return this.#replyFor(ref);
    return ok({ state: waiter.state });
  }

  /** The hook has its replies and injects them now: delivered, once. */
  confirm(fields: Fields): Answer {
    const ref = refOf(fields);
    const updateId = fields.update_id;
    if (ref === undefined || typeof updateId !== "number") return bad("bad confirm");
    const { db, waiters, inbox, log } = this.#deps;
    const delivered = db.transaction(() => {
      const done = waiters.confirm(ref, updateId);
      if (done) inbox.settleHanded(ref, "delivered");
      return done;
    });
    // The reply goes in now, and the session works on it: in `claude -p` no UserPromptSubmit says so
    // (F25), so /sessions would have it stopped (plan 7.7).
    if (delivered) this.#deps.sessions.prompted(ref.sessionId, Date.now());
    log("reply.confirmed", { ...logRef(ref), update: updateId, delivered });
    return ok({ delivered });
  }

  /** The hook stopped waiting (SIGTERM, Claude gone, a reply it couldn't confirm). */
  end(fields: Fields): Answer {
    const ref = refOf(fields);
    if (ref === undefined) return bad("bad end");
    this.#end(ref);
    return ok({});
  }

  /**
   * You typed at the Mac at `at` (UserPromptSubmit, or a cancel written while no broker ran; flow 2).
   * The session's waiters from before then stop waiting. A cancel that comes after a newer stop is late:
   * it keeps that stop's generation. The session's generation after it.
   */
  cancel(sessionId: string, at: number): number {
    const { db, sessions, waiters, log } = this.#deps;
    const done = db.transaction(() => {
      const session = sessions.get(sessionId);
      const late = session !== undefined && session.stoppedAt > at;
      const generation = late ? (session?.generation ?? 0) : sessions.advance(sessionId);
      return { generation, late, ...waiters.cancel(sessionId, at) };
    });
    for (const waiter of done.cancelled) {
      this.#answer(waiter, ok({ state: "cancelled" }));
      this.#deps.onCancelled?.(waiter);
    }
    for (const waiter of done.crossed) this.#tell(waiter.sessionId, TEXTS.crossed);
    const { cancelled, crossed, late } = done;
    const counts = { cancelled: cancelled.length, crossed: crossed.length, late };
    log("waiters.cancelled", { session: sessionId, ...counts });
    return done.generation;
  }

  /** A Stop started `generation`: the session's older waiters are over. */
  stopped(sessionId: string, generation: number): void {
    for (const waiter of this.#deps.waiters.supersede(sessionId, generation)) {
      this.#answer(waiter, ok({ state: "stale" }));
    }
  }

  /** SessionEnd: none of its waiters will get a reply, and its queue won't go in. */
  ended(sessionId: string): void {
    const { sessions, waiters, inbox } = this.#deps;
    const generation = sessions.get(sessionId)?.generation ?? 0;
    for (const waiter of waiters.supersede(sessionId, generation + 1)) {
      this.#answer(waiter, ok({ state: "ended" }));
    }
    const queued = inbox.inState("queued", sessionId);
    for (const reply of queued) inbox.mark(reply.updateId, "unrouted");
    if (queued.length > 0) this.#tell(sessionId, TEXTS.lostQueue);
  }

  /** Stores a reply before the poller moves the offset on (D7); whether it is new. */
  accept(reply: IncomingReply): boolean {
    const stored = this.#deps.inbox.store(reply);
    this.#deps.log("reply.stored", { update: reply.updateId, chars: reply.text.length, stored });
    return stored;
  }

  /**
   * Gives replies to a session (flow 4): to its waiter, with any it has queued, if it is waiting;
   * otherwise they join its queue for its next stop. "ended" when the session is gone.
   */
  deliver(sessionId: string, updateIds: readonly number[]): "handed" | "queued" | "ended" {
    const { sessions, waiters, inbox } = this.#deps;
    const session = sessions.get(sessionId);
    if (session === undefined || session.ended) return "ended";
    const waiter = waiters.listening().find((each) => each.sessionId === sessionId);
    if (waiter !== undefined && this.#handOver(waiter, updateIds)) return "handed";
    for (const updateId of updateIds) inbox.mark(updateId, "queued", { sessionId });
    return "queued";
  }

  /**
   * At start, before the broker takes replies: applies the cancels and ends written while no broker ran,
   * and ends waiters whose hook or Claude is gone (replies handed to one are reported, never resent).
   * The router then routes replies a crash left unrouted.
   */
  recover(paths: StatePaths): void {
    this.#applyPending(paths);
    const alive = this.#deps.alive ?? processAlive;
    for (const waiter of this.#deps.waiters.open()) {
      if (alive(waiter.pid) && alive(waiter.claudePid)) continue;
      this.#deps.log("waiter.gone", logRef(waiter));
      this.#end(waiter);
    }
  }

  /** Answers every open Wait (the broker is stopping); the hooks reconnect to the next broker. */
  close(): void {
    for (const key of [...this.#parked.keys()]) this.#resolve(key, ok({ state: "waiting" }));
  }

  #applyPending(paths: StatePaths): void {
    const { sessions, log } = this.#deps;
    const onBad = (file: string) => log("pending.bad", { file: basename(file) });
    for (const entry of readPending(paths, onBad)) {
      const { item } = entry;
      if (sessions.get(item.sessionId) !== undefined) {
        if (item.kind === "cancel") this.cancel(item.sessionId, item.at);
        else this.#end({ sessionId: item.sessionId, generation: item.generation });
      }
      removePending(entry);
      log("pending.applied", { kind: item.kind, session: item.sessionId });
    }
  }

  /** Hands the session's queued replies and `updateIds` to its waiting waiter, all or none. */
  #handOver(waiter: Waiter, updateIds: readonly number[]): boolean {
    const { db, waiters, inbox, log } = this.#deps;
    const queued = inbox.inState("queued", waiter.sessionId).map((reply) => reply.updateId);
    const ids = [...new Set([...queued, ...updateIds])].sort((a, b) => a - b);
    const last = ids.at(-1);
    if (last === undefined) return false;
    const handed = db.transaction(() => {
      if (!waiters.handOver(waiter, last)) return false;
      for (const updateId of ids) inbox.mark(updateId, "handed", waiter);
      return true;
    });
    if (!handed) return false;
    log("reply.handed", { ...logRef(waiter), update: last, replies: ids.length });
    this.#answer(waiter, this.#replyFor(waiter));
    return true;
  }

  #end(ref: WaiterRef): void {
    const was = this.#deps.waiters.end(ref);
    this.#deps.log("waiter.ended", { ...logRef(ref), was: was ?? "unknown" });
    if (was === "handed") {
      this.#deps.inbox.settleHanded(ref, "unconfirmed");
      this.#tell(ref.sessionId, TEXTS.unconfirmed);
    }
    this.#resolve(waiterKey(ref), ok({ state: "ended" }));
  }

  #park(ref: WaiterRef): Promise<Answer> {
    const key = waiterKey(ref);
    // An earlier call of the same waiter (it reconnected) gets its answer now.
    this.#resolve(key, ok({ state: "waiting" }));
    return new Promise((resolve) => {
      const hold = this.#deps.holdMs ?? 25_000;
      const timer = setTimeout(() => this.#resolve(key, ok({ state: "waiting" })), hold);
      this.#parked.set(key, { resolve, timer });
    });
  }

  /** The replies handed to this waiter, as one text, oldest first. */
  #replyFor(ref: WaiterRef): Answer {
    const replies = this.#deps.inbox.handedTo(ref);
    return ok({
      state: "reply",
      update_id: this.#deps.waiters.get(ref)?.updateId ?? 0,
      text: replies.map((reply) => reply.text).join("\n\n"),
      from: this.#deps.senderName(),
    });
  }

  #answer(ref: WaiterRef, answer: Answer): void {
    this.#resolve(waiterKey(ref), answer);
  }

  #resolve(key: string, answer: Answer): void {
    const parked = this.#parked.get(key);
    if (parked === undefined) return;
    clearTimeout(parked.timer);
    this.#parked.delete(key);
    parked.resolve(answer);
  }

  #tell(sessionId: string, text: (name: string) => string): void {
    const session = this.#deps.sessions.get(sessionId);
    this.#deps.tell(text(session === undefined ? "a session" : label(session))).catch((error) => {
      this.#deps.log("reply.tell-failed", { error: messageOf(error) });
    });
  }
}

function refOf(fields: Fields): WaiterRef | undefined {
  const { session_id: sessionId, generation } = fields;
  if (typeof sessionId !== "string" || sessionId === "" || typeof generation !== "number") {
    return undefined;
  }
  return { sessionId, generation };
}

function logRef(ref: WaiterRef) {
  return { session: ref.sessionId, generation: ref.generation };
}
