import { messageOf } from "../shared/errors.ts";
import { type BackgroundTask, parseTasks } from "../shared/hook-input.ts";
import { asFields, type Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { failureNotice, finishNotice, permissionNotice, questionNotice } from "./notices.ts";
import type { NoticeOf, Notifier } from "./notifier.ts";
import type { Pairing } from "./pairing.ts";
import type { Session, SessionRef, Sessions } from "./sessions.ts";

export interface HookEventsDeps {
  readonly sessions: Sessions;
  readonly notifier: Pick<Notifier, "send">;
  readonly pairing: Pick<Pairing, "pairedUser">;
  readonly log: Log;
}

type Answer = { readonly status: number; readonly body: unknown };

/** A session's latest stop, kept in memory for idle_prompt, which may come a minute later (F6). */
interface LastStop {
  readonly generation: number;
  readonly outcome: string;
  readonly text: string;
  readonly tasks: readonly BackgroundTask[];
  sent: boolean;
}

/**
 * What the broker does with each hook's call (design §3, plan 2.7). A stop's result counts only in its
 * own generation, so typing at the Mac first cancels it (flow 2). Notices are sent in the background:
 * a hook never waits for Telegram.
 */
export class HookEvents {
  readonly #deps: HookEventsDeps;
  readonly #lastStops = new Map<string, LastStop>();

  constructor(deps: HookEventsDeps) {
    this.#deps = deps;
  }

  handle(event: string, body: unknown): Answer {
    const fields = asFields(body) ?? {};
    const ref = sessionRef(fields);
    if (ref === undefined) return { status: 400, body: { ok: false, error: "no session" } };
    this.#deps.log("hook.event", { hook: event, session: ref.id });
    const { sessions } = this.#deps;
    switch (event) {
      case "SessionStart":
        sessions.touch(ref, typeof fields.branch === "string" ? fields.branch : undefined);
        return ok({ name: firstName(this.#deps.pairing.pairedUser()?.name) });
      case "UserPromptSubmit":
        sessions.touch(ref);
        return ok({ generation: sessions.advance(ref.id) });
      case "Stop":
        sessions.touch(ref);
        return ok({ generation: sessions.advance(ref.id) });
      case "SessionEnd":
        sessions.end(ref.id);
        this.#lastStops.delete(ref.id);
        return ok({});
      default:
        return this.#notify(event, sessions.touch(ref), fields);
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
      return { status: 400, body: { ok: false, error: "bad stop result" } };
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

function ok(fields: object): Answer {
  return { status: 200, body: { ok: true, pid: process.pid, ...fields } };
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
