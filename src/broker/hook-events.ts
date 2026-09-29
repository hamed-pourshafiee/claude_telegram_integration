import { messageOf } from "../shared/errors.ts";
import { type BackgroundTask, parseTasks } from "../shared/hook-input.ts";
import { asFields, type Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { type Answer, bad, ok } from "./answer.ts";
import type { AskRelay } from "./ask-relay.ts";
import { failureNotice, finishNotice, permissionNotice, questionNotice } from "./notices.ts";
import type { NoticeOf, Notifier } from "./notifier.ts";
import type { Pairing } from "./pairing.ts";
import type { Relay } from "./relay.ts";
import type { Session, SessionRef, Sessions } from "./sessions.ts";

export interface HookEventsDeps {
  readonly sessions: Sessions;
  readonly notifier: Pick<Notifier, "send">;
  readonly pairing: Pick<Pairing, "pairedUser">;
  /** Waiting Stop hooks and the replies they get (plan 3.1). */
  readonly relay: Pick<Relay, "wait" | "confirm" | "end" | "cancel" | "stopped" | "ended">;
  /** Waiting question hooks and your answers (plan 4.1). */
  readonly asks: Pick<AskRelay, "ask" | "confirm" | "end" | "asked" | "moved" | "sessionEnded">;
  readonly log: Log;
}

/** A session's latest stop, kept in memory for idle_prompt, which may come a minute later (F6). */
interface LastStop {
  readonly generation: number;
  readonly outcome: string;
  readonly text: string;
  readonly tasks: readonly BackgroundTask[];
  sent: boolean;
}

/**
 * What the broker does with each hook's call (design §3, plans 2.7 and 3.1). A stop's result counts only
 * in its own generation, so typing at the Mac first cancels it, and its waiter too (flow 2). Notices are
 * sent in the background: a hook never waits for Telegram. A waiting hook's calls go to the relay.
 */
export class HookEvents {
  readonly #deps: HookEventsDeps;
  readonly #lastStops = new Map<string, LastStop>();

  constructor(deps: HookEventsDeps) {
    this.#deps = deps;
  }

  handle(event: string, body: unknown): Answer | Promise<Answer> {
    const fields = asFields(body) ?? {};
    const ref = sessionRef(fields);
    if (ref === undefined) return bad("no session");
    const waiting = this.#waiting(event, ref, fields);
    if (waiting !== undefined) return waiting;
    this.#deps.log("hook.event", { hook: event, session: ref.id });
    const { sessions, relay, asks } = this.#deps;
    switch (event) {
      case "SessionStart":
        sessions.touch(ref, typeof fields.branch === "string" ? fields.branch : undefined);
        return ok({ name: firstName(this.#deps.pairing.pairedUser()?.name) });
      case "UserPromptSubmit": {
        sessions.touch(ref);
        asks.moved(ref.id);
        // When you typed, as the hook saw it: a cancel that arrives after a newer stop is late.
        const at = typeof fields.at === "number" ? fields.at : Date.now();
        return ok({ generation: relay.cancel(ref.id, at) });
      }
      case "Stop": {
        sessions.touch(ref);
        asks.moved(ref.id);
        const generation = sessions.stop(ref.id);
        relay.stopped(ref.id, generation);
        return ok({ generation });
      }
      case "SessionEnd":
        sessions.end(ref.id);
        relay.ended(ref.id);
        asks.sessionEnded(ref.id);
        this.#lastStops.delete(ref.id);
        return ok({});
      case "Asked":
        if (typeof fields.tool_use_id === "string") asks.asked(ref.id, fields.tool_use_id);
        return ok({});
      default:
        return this.#notify(event, sessions.touch(ref), fields);
    }
  }

  /**
   * A waiting hook's calls, which don't touch the session: it may have ended meanwhile. A question
   * hook's first Ask registers a session the broker hasn't heard of.
   */
  #waiting(event: string, ref: SessionRef, fields: Fields): Answer | Promise<Answer> | undefined {
    const { relay, asks, sessions } = this.#deps;
    switch (event) {
      case "Wait":
        return relay.wait(fields);
      case "Confirm":
        return relay.confirm(fields);
      case "End":
        return relay.end(fields);
      case "Ask":
        if (sessions.get(ref.id) === undefined) sessions.touch(ref);
        return asks.ask(fields);
      case "AskConfirm":
        return asks.confirm(fields);
      case "AskEnd":
        return asks.end(fields);
      default:
        return undefined;
    }
  }

  #notify(event: string, session: Session, fields: Fields): Answer {
    switch (event) {
      case "StopResult":
        return this.#stopResult(session, fields);
      case "Idle":
        this.#finish(session, this.#lastStops.get(session.id));
        return ok({});
      case "PermissionRequest": {
        const tool = typeof fields.tool === "string" ? fields.tool : "a tool";
        const input = asFields(fields.input);
        this.#send("permission", session, (name, mode) =>
          permissionNotice(name, tool, input, mode),
        );
        return ok({});
      }
      case "Question":
        this.#send("question", session, (name, mode) =>
          questionNotice(name, fields.questions, mode),
        );
        return ok({});
      case "StopFailure": {
        const error = typeof fields.error === "string" ? fields.error : "";
        this.#send("failure", session, (name) => failureNotice(name, error));
        return ok({});
      }
      default:
        return ok({});
    }
  }

  #stopResult(session: Session, fields: Fields): Answer {
    const { generation, outcome, text } = fields;
    if (typeof generation !== "number" || typeof outcome !== "string" || typeof text !== "string") {
      return bad("bad stop result");
    }
    const current = generation === session.generation;
    this.#deps.log("stop.result", { session: session.id, generation, outcome, current });
    // Typed at the Mac, another stop, or the end of the session since: this stop is over.
    if (!current) return ok({ current });
    const last: LastStop = {
      generation,
      outcome,
      text,
      tasks: parseTasks(fields.tasks),
      sent: false,
    };
    this.#lastStops.set(session.id, last);
    if (outcome === "finish") this.#finish(session, last);
    return ok({ current });
  }

  /**
   * The ✅ for the session's latest stop, unless it went out already, the session moved on, or Claude
   * is continuing. After an "unknown" stop only idle_prompt calls this (flow 1).
   */
  #finish(session: Session, last: LastStop | undefined): void {
    if (last === undefined || last.sent || last.generation !== session.generation) return;
    if (last.outcome === "continuing") return;
    last.sent = true;
    const noticeOf: NoticeOf = (name, mode) => finishNotice(name, last.text, last.tasks, mode);
    this.#send("finish", session, noticeOf, (sent) => {
      // Not sent because you were at the Mac: idle_prompt may still send it if you leave.
      if (!sent) last.sent = false;
    });
  }

  #send(kind: string, session: Session, noticeOf: NoticeOf, then?: (sent: boolean) => void): void {
    this.#deps.notifier
      .send(kind, session, noticeOf)
      .then((sent) => then?.(sent))
      .catch((error: unknown) => {
        then?.(false);
        this.#deps.log("notice.failed", { kind, session: session.id, error: messageOf(error) });
      });
  }
}

function sessionRef(fields: Fields): SessionRef | undefined {
  const { session_id: id, project_dir: projectDir, entrypoint } = fields;
  if (typeof id !== "string" || id === "" || typeof projectDir !== "string") return undefined;
  return { id, projectDir, entrypoint: typeof entrypoint === "string" ? entrypoint : "" };
}

/** The first name in a paired user's name, as pairing stores it: "Hamed (@someone)" → "Hamed". */
export function firstName(name: string | undefined): string | null {
  const first = name?.replace(/ \(@[^)]*\)$/, "").trim();
  return first ? first : null;
}
