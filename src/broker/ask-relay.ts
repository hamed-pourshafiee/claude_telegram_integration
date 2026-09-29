import { messageOf } from "../shared/errors.ts";
import type { Fields } from "../shared/json.ts";
import type { Log, LogFields } from "../shared/log.ts";
import { processAlive } from "../shared/process.ts";
import { type Answer, bad, ok } from "./answer.ts";
import { type Call, callOf, keptOf, newAskId, type Where, whereOf } from "./ask-calls.ts";
import type { AskMessages, Settled } from "./ask-messages.ts";
import type { Ask, Asks } from "./asks.ts";
import type { Presence } from "./presence.ts";
import { parseAskInput } from "./questions.ts";
import type { Session, Sessions } from "./sessions.ts";

export interface AskRelayDeps {
  readonly sessions: Pick<Sessions, "get">;
  readonly asks: Asks;
  readonly messages: Pick<AskMessages, "post" | "settled">;
  /** Decides where a new call goes (flow 3); see askWhere(). */
  readonly where: (session: Session) => Where;
  readonly presence: Pick<Presence, "hurry">;
  readonly log: Log;
  /** A call that went to the Mac at once, which you may still have to hear of (flow 3). */
  readonly onLocal?: (ask: Ask) => void;
  /** Every step of a permission prompt (D9): relayed, answered, delivered, moved, ended. */
  readonly audit?: Log;
  /** How long an Ask is held before it answers "waiting"; default 25 s. */
  readonly holdMs?: number;
  /** Whether a process runs; default: a signal-0 kill. */
  readonly alive?: (pid: number) => boolean;
  readonly newId?: () => string;
}

interface Parked {
  readonly resolve: (answer: Answer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Claude's questions for waiting PreToolUse hooks (flow 3, plan 4.1). A hook asks where its call goes:
 * to the dialog at the Mac, answered at once, or to the chat, where it waits like a Stop hook's Wait
 * until your answers come, or the call goes to the Mac after all. Answers are confirmed by the hook
 * before it hands them to Claude, so any it can't take are reported, never lost unseen (D7). The
 * database decides every race between an answer here and a move to the Mac.
 */
export class AskRelay {
  readonly #deps: AskRelayDeps;
  readonly #parked = new Map<string, Parked>();

  constructor(deps: AskRelayDeps) {
    this.#deps = deps;
  }

  /** A hook asks where its call goes, and asks again while the call waits in the chat. */
  ask(fields: Fields): Answer | Promise<Answer> {
    const call = callOf(fields);
    if (call === undefined) return bad("bad ask");
    const session = this.#deps.sessions.get(call.sessionId);
    if (session === undefined || session.ended) return ok({ state: "ended" });
    const ask = this.#deps.asks.find(session.id, call.toolUseId) ?? this.#create(session, call);
    return ask.state === "remote" ? this.#park(ask.id) : this.#answerFor(ask);
  }

  /** The hook has the answers and hands them to Claude now: delivered, once. */
  confirm(fields: Fields): Answer {
    const ask = this.#find(fields);
    if (ask === undefined) return bad("bad confirm");
    const moved = this.#deps.asks.move(ask.id, ["answered"], "delivered");
    const delivered = moved || ask.state === "delivered";
    this.#deps.log("ask.confirmed", { ask: ask.id, delivered });
    if (moved) this.#audit("permission.delivered", ask, {});
    return ok({ delivered });
  }

  /** The hook stopped waiting: SIGTERM (Esc at the Mac, or its timeout), or its Claude is gone. */
  end(fields: Fields): Answer {
    const ask = this.#find(fields);
    if (ask === undefined) return bad("bad end");
    this.#end(ask, "hook stopped");
    return ok({});
  }

  /** PostToolUse: Claude has the answers, from the chat or from the dialog. */
  asked(sessionId: string, toolUseId: string): void {
    const ask = this.#deps.asks.find(sessionId, toolUseId);
    if (ask !== undefined) this.#close(ask);
  }

  /** You typed at the Mac, or the turn stopped: a call open in the dialog is over. */
  moved(sessionId: string): void {
    // A permission prompt answered at the Mac leaves its hook waiting: Claude Code drops its answer.
    for (const ask of this.#deps.asks.inState(["remote"], sessionId)) {
      this.release(ask.id, "the turn moved on", "atMac");
    }
    for (const ask of this.#deps.asks.inState(["local", "delivered"], sessionId)) this.#close(ask);
  }

  /** SessionEnd: nothing of the session is asked any more. */
  sessionEnded(sessionId: string): void {
    for (const ask of this.#deps.asks.inState(["remote", "answered"], sessionId)) {
      this.#end(ask, "session ended");
    }
    this.moved(sessionId);
  }

  /** Hands a call in the chat to the dialog at the Mac: you're back, or chose it; whether it moved. */
  release(id: string, why: string, how: Settled = "moved"): boolean {
    const ask = this.#deps.asks.get(id);
    if (ask === undefined || !this.#deps.asks.move(id, ["remote"], "local")) return false;
    this.#deps.log("ask.local", { ask: id, why });
    this.#audit("permission.at-mac", ask, { why });
    this.#resolve(id, ok({ state: "local" }));
    this.#settle(ask, how, false);
    this.#hurry();
    return true;
  }

  /** Your last answer came in the chat (the call is answered): its hook gets them all. */
  completed(id: string): void {
    const ask = this.#deps.asks.get(id);
    if (ask === undefined) return;
    this.#deps.log("ask.answered", { ask: id });
    this.#resolve(id, this.#answerFor(ask));
    this.#hurry();
  }

  /**
   * At start: calls whose hook or Claude went while no broker ran are over, and you're told of answers
   * that never went in. Calls whose hook still waits stay; it asks the new broker again.
   */
  recover(): void {
    const alive = this.#deps.alive ?? processAlive;
    for (const ask of this.#deps.asks.inState(["remote", "answered"])) {
      if (!alive(ask.pid) || !alive(ask.claudePid)) this.#end(ask, "hook gone");
    }
    for (const ask of this.#deps.asks.inState(["local", "delivered"])) {
      if (!alive(ask.claudePid)) this.#close(ask);
    }
    this.#deps.asks.prune();
    this.#hurry();
  }

  /** Answers every held Ask (the broker is stopping); the hooks ask the next broker. */
  close(): void {
    for (const id of [...this.#parked.keys()]) this.#resolve(id, ok({ state: "waiting" }));
  }

  #create(session: Session, call: Call): Ask {
    const { asks, log } = this.#deps;
    const input = parseAskInput(call.input);
    const where = whereOf(input, session, this.#deps.where);
    const raw = JSON.stringify(keptOf(call.input));
    const ask = asks.create({
      id: this.#deps.newId?.() ?? newAskId(),
      sessionId: session.id,
      toolUseId: call.toolUseId,
      pid: call.pid,
      claudePid: call.claudePid,
      state: "chat" in where ? "remote" : "local",
      raw,
      count: input?.questions.length ?? 0,
    });
    const why = "local" in where ? { why: where.local } : {};
    const questions = input?.questions.length ?? 0;
    const plan = input?.plan !== undefined;
    const fields = { session: session.id, ask: ask.id, state: ask.state, questions, plan, ...why };
    log("ask.created", fields);
    this.#audit("permission.asked", ask, { relayed: ask.state === "remote", ...why });
    if ("chat" in where) this.#post(ask, session, where.chat);
    else this.#deps.onLocal?.(ask);
    this.#hurry();
    return ask;
  }

  #post(ask: Ask, session: Session, chat: number): void {
    this.#deps.messages.post(ask, session, chat).catch((error: unknown) => {
      this.#deps.log("ask.post-failed", { ask: ask.id, error: messageOf(error) });
      this.release(ask.id, "not sent");
    });
  }

  /** What a hook is told of a call that isn't waiting in the chat. */
  #answerFor(ask: Ask): Answer {
    if (ask.state === "local") return ok({ state: "local" });
    if (ask.state === "answered" || ask.state === "delivered") {
      const answers = this.#deps.asks.answers(ask);
      if (answers !== undefined) return ok({ state: "answered", answers });
    }
    return ok({ state: "ended" });
  }

  #end(ask: Ask, why: string): void {
    if (!this.#deps.asks.move(ask.id, ["remote", "answered"], "ended")) return;
    this.#deps.log("ask.ended", { ask: ask.id, was: ask.state, why });
    this.#audit("permission.ended", ask, { was: ask.state, why });
    this.#resolve(ask.id, ok({ state: "ended" }));
    this.#settle(ask, ask.state === "answered" ? "lost" : "withdrawn", true);
    this.#hurry();
  }

  #close(ask: Ask): void {
    if (!this.#deps.asks.move(ask.id, ["local", "delivered", "answered"], "closed")) return;
    this.#deps.asks.forget(ask.id);
    this.#deps.log("ask.closed", { ask: ask.id, was: ask.state });
  }

  /** Its messages say how the call left the chat; then its text goes, if it is over (D8). */
  #settle(ask: Ask, how: Settled, over: boolean): void {
    this.#deps.messages
      .settled(ask, how)
      .catch((error: unknown) => {
        this.#deps.log("ask.edit-failed", { ask: ask.id, error: messageOf(error) });
      })
      .then(() => {
        if (over) this.#deps.asks.forget(ask.id);
      })
      .catch((error: unknown) => {
        // The database may be closing with the broker; the next start prunes old calls anyway.
        this.#deps.log("ask.forget-failed", { ask: ask.id, error: messageOf(error) });
      });
  }

  /** A permission prompt's step, in the audit log (D9): by its ref, never its text. */
  #audit(event: string, ask: Ask, fields: LogFields): void {
    const permission = ask.input?.permission;
    if (permission === undefined) return;
    const bound = {
      session: ask.sessionId,
      ask: ask.id,
      tool: permission.tool,
      ref: permission.hash,
    };
    this.#deps.audit?.(event, { ...bound, ...fields });
  }

  /** In between, presence looks every second while a call waits in the chat (flow 3). */
  #hurry(): void {
    this.#deps.presence.hurry(this.#deps.asks.inState(["remote"]).length > 0);
  }

  #find(fields: Fields): Ask | undefined {
    const { session_id: sessionId, tool_use_id: toolUseId } = fields;
    if (typeof sessionId !== "string" || typeof toolUseId !== "string") return undefined;
    return this.#deps.asks.find(sessionId, toolUseId);
  }

  #park(id: string): Promise<Answer> {
    // An earlier Ask of the same hook (it reconnected) gets its answer now.
    this.#resolve(id, ok({ state: "waiting" }));
    return new Promise((resolve) => {
      const hold = this.#deps.holdMs ?? 25_000;
      const timer = setTimeout(() => this.#resolve(id, ok({ state: "waiting" })), hold);
      this.#parked.set(id, { resolve, timer });
    });
  }

  #resolve(id: string, answer: Answer): void {
    const parked = this.#parked.get(id);
    if (parked === undefined) return;
    clearTimeout(parked.timer);
    this.#parked.delete(id);
    parked.resolve(answer);
  }
}
