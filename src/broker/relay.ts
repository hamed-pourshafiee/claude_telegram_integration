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
}

interface Parked {
  readonly resolve: (answer: Answer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const TEXTS = {
  nobody: "Nobody is waiting for a reply right now, so your message wasn't delivered.",
  several:
    "Several sessions are waiting for a reply, and I can't tell which one you mean yet, so your " +
    "message wasn't delivered.",
  crossed: (name: string) =>
    `↩️ Your message to ${name} crossed with typing at the Mac. It was already on its way, so ` +
    "Claude still gets it.",
  unconfirmed: (name: string) =>
    `⚠️ Your message to ${name} was handed over but never confirmed, so it may not have arrived. ` +
    "It wasn't sent again.",
} as const;

/**
 * Replies from Telegram to waiting Stop hooks (flows 1, 2 and 4; plan 3.1). The database decides every
 * race; this class keeps the waiters' open Wait calls and answers them when there is news. A reply is
 * stored before the offset moves on, handed to one waiter, and delivered once that waiter confirms, so
 * nothing is injected twice (D7). What a crash leaves behind is sorted out by recover() at start.
 */
export class Relay {
  readonly #deps: RelayDeps;
  readonly #parked = new Map<string, Parked>();

  constructor(deps: RelayDeps) {
    this.#deps = deps;
  }

  /** A Stop hook waits: registered, then answered when there is news for it or after the hold. */
  wait(fields: Fields): Answer | Promise<Answer> {
    const ref = refOf(fields);
    const { pid, claude_pid: claudePid } = fields;
    if (ref === undefined || typeof pid !== "number" || typeof claudePid !== "number") {
      return bad("bad wait");
    }
    const waiter = this.#deps.waiters.register({ ...ref, pid, claudePid });
    if (waiter === "stale") return ok({ state: "stale" });
    if (waiter.state === "waiting") return this.#park(ref);
    if (waiter.state === "handed") return this.#replyFor(waiter);
    return ok({ state: waiter.state });
  }

  /** The hook has the reply and injects it now: delivered, once. */
  confirm(fields: Fields): Answer {
    const ref = refOf(fields);
    const updateId = fields.update_id;
    if (ref === undefined || typeof updateId !== "number") return bad("bad confirm");
    const { db, waiters, inbox, log } = this.#deps;
    const delivered = db.transaction(() => {
      const done = waiters.confirm(ref, updateId);
      if (done) inbox.mark(updateId, "delivered", ref);
      return done;
    });
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
    for (const waiter of done.cancelled) this.#settle(waiter, { state: "cancelled" });
    for (const waiter of done.crossed) this.#tell(waiter, TEXTS.crossed);
    const { cancelled, crossed, late } = done;
    log("waiters.cancelled", {
      session: sessionId,
      cancelled: cancelled.length,
      crossed: crossed.length,
      late,
    });
    return done.generation;
  }

  /** A Stop started `generation`: the session's older waiters are over. */
  stopped(sessionId: string, generation: number): void {
    for (const waiter of this.#deps.waiters.supersede(sessionId, generation)) {
      this.#settle(waiter, { state: "stale" });
    }
  }

  /** SessionEnd: none of its waiters will get a reply. */
  ended(sessionId: string): void {
    const generation = this.#deps.sessions.get(sessionId)?.generation ?? 0;
    for (const waiter of this.#deps.waiters.supersede(sessionId, generation + 1)) {
      this.#settle(waiter, { state: "ended" });
    }
  }

  /** Stores a reply before the poller moves the offset on (D7); whether it is new. */
  accept(reply: IncomingReply): boolean {
    const stored = this.#deps.inbox.store(reply);
    this.#deps.log("reply.stored", { update: reply.updateId, chars: reply.text.length, stored });
    return stored;
  }

  /** Hands a stored reply to the one session listening (plan 3.2 adds reply-to, the picker, a queue). */
  route(updateId: number): void {
    const { db, waiters, inbox, log } = this.#deps;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (inbox.get(updateId)?.state !== "new") return;
      const listening = waiters.listening();
      const [target] = listening;
      if (target === undefined || listening.length > 1) {
        inbox.mark(updateId, "unrouted");
        log("reply.unrouted", { update: updateId, listening: listening.length });
        this.#say(target === undefined ? TEXTS.nobody : TEXTS.several);
        return;
      }
      const handed = db.transaction(() => {
        if (!waiters.handOver(target, updateId)) return false;
        inbox.mark(updateId, "handed", target);
        return true;
      });
      // Lost the race to a cancel or a newer stop: look again.
      if (!handed) continue;
      log("reply.handed", { ...logRef(target), update: updateId });
      const waiter = waiters.get(target);
      if (waiter !== undefined) this.#answer(waiter, this.#replyFor(waiter));
      return;
    }
  }

  /**
   * At start, before the broker takes replies: applies the cancels and ends written while no broker ran,
   * ends waiters whose hook or Claude is gone (a reply handed to one is reported, never resent), and
   * routes replies that a crash left unrouted.
   */
  recover(paths: StatePaths): void {
    this.#applyPending(paths);
    const alive = this.#deps.alive ?? processAlive;
    for (const waiter of this.#deps.waiters.open()) {
      if (alive(waiter.pid) && alive(waiter.claudePid)) continue;
      this.#deps.log("waiter.gone", logRef(waiter));
      this.#end(waiter);
    }
    for (const reply of this.#deps.inbox.unrouted()) this.route(reply.updateId);
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

  #end(ref: WaiterRef): void {
    const waiter = this.#deps.waiters.get(ref);
    const was = this.#deps.waiters.end(ref);
    this.#deps.log("waiter.ended", { ...logRef(ref), was: was ?? "unknown" });
    if (was === "handed" && waiter?.updateId !== undefined) {
      this.#deps.inbox.mark(waiter.updateId, "unconfirmed", ref);
      this.#tell(waiter, TEXTS.unconfirmed);
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

  #replyFor(waiter: Waiter): Answer {
    const reply = waiter.updateId === undefined ? undefined : this.#deps.inbox.get(waiter.updateId);
    return ok({
      state: "reply",
      update_id: waiter.updateId ?? 0,
      text: reply?.text ?? "",
      from: this.#deps.senderName(),
    });
  }

  #settle(ref: WaiterRef, fields: object): void {
    this.#resolve(waiterKey(ref), ok(fields));
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

  #tell(ref: WaiterRef, text: (name: string) => string): void {
    const session = this.#deps.sessions.get(ref.sessionId);
    this.#say(text(session === undefined ? "a session" : label(session)));
  }

  #say(text: string): void {
    this.#deps.tell(text).catch((error: unknown) => {
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
