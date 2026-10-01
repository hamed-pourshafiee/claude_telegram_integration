import { randomUUID } from "node:crypto";
import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import { processAlive } from "../shared/process.ts";
import type { Launch, Launched } from "./session-launch.ts";
import { BACKGROUND_ENTRYPOINT, type Sessions } from "./sessions.ts";

export interface BackgroundDeps {
  readonly sessions: Pick<Sessions, "open" | "get" | "startedHere" | "end">;
  readonly launch: Launch;
  /** Tells the paired user something: a session that stopped with an error. */
  readonly tell: (text: string) => Promise<void>;
  readonly log: Log;
  /** Every start (D11), by session and folder, never the message. */
  readonly audit: Log;
  /** Whether a process runs; default: a signal-0 kill. */
  readonly alive?: (pid: number) => boolean;
  readonly newId?: () => string;
}

/** What a reply to a /new question did: the note for the chat, and whether a session started. */
export interface Started {
  readonly started: boolean;
  readonly text: string;
}

/** A session to start in the background, in a window's folder, with its first message. */
export interface Run {
  readonly folder: string;
  readonly name: string;
  readonly message: string;
  /** A workspace's other folders (`--add-dir`). */
  readonly addDirs: readonly string[];
}

/** The most sessions started from the chat that run in the background at once (D11). */
export const MOST_RUNNING = 3;

const TEXTS = {
  full: `${MOST_RUNNING} sessions started here still run in the background. Wait for one to end.`,
  started: (name: string) =>
    `🚀 Starting a session in ${name}, in the background. Its messages come here, and your replies go to it.`,
  notStarted: (name: string, why: string) => `⚠️ The session in ${name} didn't start: ${why}`,
  stopped: (name: string, code: number) =>
    `⚠️ The session in ${name} stopped with an error (exit code ${code}). .state/logs/sessions.log on the Mac may say why.`,
} as const;

/**
 * The sessions /new runs in the background (D11, plan 7.7), when no tab took the message or the window
 * has closed: `claude -p` in the window's folder, at most 3 at once, each ended here when its process
 * ends.
 */
export class BackgroundSessions {
  readonly #deps: BackgroundDeps;

  constructor(deps: BackgroundDeps) {
    this.#deps = deps;
  }

  start(run: Run): Started {
    if (this.#running() >= MOST_RUNNING) return { started: false, text: TEXTS.full };
    const id = this.#deps.newId?.() ?? randomUUID();
    const ref = { id, projectDir: run.folder, entrypoint: BACKGROUND_ENTRYPOINT };
    this.#deps.sessions.startedHere(ref, "background");
    let launched: Launched;
    try {
      launched = this.#deps.launch(id, run.folder, run.message, run.addDirs);
    } catch (error) {
      this.#deps.sessions.end(id);
      this.#deps.log("new.failed", { session: id, error: messageOf(error) });
      return { started: false, text: TEXTS.notStarted(run.name, messageOf(error)) };
    }
    this.#watch(id, run.name, launched);
    const fields = { session: id, folder: run.folder, by: "chat", in: "background" };
    this.#deps.audit("session.started", fields);
    this.#deps.log("new.started", { session: id, claude: launched.pid });
    return { started: true, text: TEXTS.started(run.name) };
  }

  /** What to say when a start failed for a reason of its own. */
  failed(name: string, error: unknown): Started {
    return { started: false, text: TEXTS.notStarted(name, messageOf(error)) };
  }

  /** When the session's process ends: ended here too, and you hear of an error. */
  #watch(id: string, name: string, launched: Launched): void {
    const { sessions, tell, log } = this.#deps;
    launched.exited
      .then(async (code) => {
        log("new.exited", { session: id, code });
        if (sessions.get(id)?.ended === false) sessions.end(id);
        if (code !== 0) await tell(TEXTS.stopped(name, code));
      })
      .catch((error: unknown) => log("new.watch-failed", { session: id, error: messageOf(error) }));
  }

  /** Sessions /new runs in the background that still run, or haven't reported yet. */
  #running(): number {
    const alive = this.#deps.alive ?? processAlive;
    return this.#deps.sessions
      .open()
      .filter(
        (session) => session.inBackground && (session.claudePid === 0 || alive(session.claudePid)),
      ).length;
  }
}
