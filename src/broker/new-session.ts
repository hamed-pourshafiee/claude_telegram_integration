import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Config } from "../shared/config.ts";
import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import { processAlive } from "../shared/process.ts";
import { contentModeFor, sessionScope } from "../shared/scope.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { CommandAnswer } from "./commands.ts";
import type { Launch, Launched } from "./session-launch.ts";
import type { Sessions } from "./sessions.ts";
import type { Start, Starts } from "./starts.ts";

export interface NewSessionsDeps {
  readonly sessions: Pick<Sessions, "folders" | "open" | "get" | "startedHere" | "end">;
  readonly starts: Pick<Starts, "record" | "use">;
  readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  readonly config: Config;
  readonly launch: Launch;
  /** The paired user's first name, for the mark on the first message. */
  readonly senderName: () => string | null;
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

/** The most sessions started from the chat that run at once (D11). */
export const MOST_RUNNING = 3;
/** The most folders /new offers. */
const MOST_FOLDERS = 8;
/** The most characters of the reply box's placeholder. */
const PLACEHOLDER_CHARS = 64;
const BUTTON = /^new:([0-9a-f]{16})$/;

const TEXTS = {
  which:
    "📂 A new session: in which folder?\nIt runs on the Mac in the background, not in a VS Code tab, and reports here.",
  none: "No folder to offer yet: a folder shows up here once a session there has used the bridge.",
  noCli:
    "Sessions started here run as terminal sessions, and config.json doesn't serve those (entrypoints).",
  gone: "That folder isn't offered any more.",
  full: `${MOST_RUNNING} sessions started here still run. Wait for one to end.`,
  expired: "That question has expired, so nothing was started. Send /new again.",
  taken: "A session was already started from that question.",
  failed: "The reply box didn't open. Try again.",
  ask: (name: string) =>
    `✏️ Your first message for a new session in ${name}\nThe session starts when you send it.`,
  started: (name: string) =>
    `🚀 Starting a session in ${name}. Its messages come here, and your replies go to it.`,
  notStarted: (name: string, why: string) => `⚠️ The session in ${name} didn't start: ${why}`,
  stopped: (name: string, code: number) =>
    `⚠️ The session in ${name} stopped with an error (exit code ${code}). .state/logs/sessions.log on the Mac may say why.`,
} as const;

/**
 * /new (D11, plan 7.7). No hook can start a VS Code tab working (F24), so the bridge starts the session
 * itself: you pick a folder, write the first message in the reply box, and the broker runs `claude -p`
 * there. Its hooks then send its messages here like any session's, and your replies continue it (F25).
 */
export class NewSessions {
  readonly #deps: NewSessionsDeps;

  constructor(deps: NewSessionsDeps) {
    this.#deps = deps;
  }

  /** The answer to /new: a button for each folder offered, the one used last first. */
  answer(): CommandAnswer {
    if (!this.#deps.config.entrypoints.includes("cli")) return { text: TEXTS.noCli };
    const folders = this.#folders();
    if (folders.length === 0) return { text: TEXTS.none };
    const names = folderNames(folders);
    const inline_keyboard = folders.map((dir, at) => [
      { text: `📂 ${names[at] ?? dir}`, callback_data: `new:${keyOf(dir)}` },
    ]);
    return { text: TEXTS.which, reply_markup: { inline_keyboard } };
  }

  /** A tap on a folder: the question for the first message, with the reply box open on it. */
  async press(data: string, chat: number, queryId: string): Promise<void> {
    const key = BUTTON.exec(data)?.[1];
    const folders = this.#folders();
    const at = folders.findIndex((dir) => keyOf(dir) === key);
    const dir = folders[at];
    const toast = (text?: string) =>
      this.#deps.telegram.answerCallbackQuery({
        callback_query_id: queryId,
        ...(text === undefined ? {} : { text }),
      });
    if (dir === undefined) return toast(TEXTS.gone);
    if (this.#running() >= MOST_RUNNING) return toast(TEXTS.full);
    const name = folderNames(folders)[at] ?? basename(dir);
    try {
      const placeholder = Array.from(`First message for ${name}`).slice(0, PLACEHOLDER_CHARS);
      const sent = await this.#deps.telegram.sendMessage({
        chat_id: chat,
        text: TEXTS.ask(name),
        reply_markup: { force_reply: true, input_field_placeholder: placeholder.join("") },
      });
      this.#deps.starts.record(chat, sent.message_id, dir);
    } catch (error) {
      this.#deps.log("new.ask-failed", { error: messageOf(error) });
      return toast(TEXTS.failed);
    }
    this.#deps.log("new.asked", {});
    return toast();
  }

  /** A reply to a /new question: a session starts in its folder, with the reply as its first message. */
  start(text: string, start: Start): Started {
    const name = basename(start.projectDir);
    const taken = this.#deps.starts.use(start);
    if (taken !== "used") {
      return { started: false, text: taken === "expired" ? TEXTS.expired : TEXTS.taken };
    }
    if (!this.#offers(start.projectDir)) return { started: false, text: TEXTS.gone };
    if (this.#running() >= MOST_RUNNING) return { started: false, text: TEXTS.full };
    const id = this.#deps.newId?.() ?? randomUUID();
    const from = this.#deps.senderName() ?? "the user";
    this.#deps.sessions.startedHere({ id, projectDir: start.projectDir, entrypoint: "cli" });
    let launched: Launched;
    try {
      launched = this.#deps.launch(id, start.projectDir, `📨 From ${from} on Telegram: ${text}`);
    } catch (error) {
      this.#deps.sessions.end(id);
      this.#deps.log("new.failed", { session: id, error: messageOf(error) });
      return { started: false, text: TEXTS.notStarted(name, messageOf(error)) };
    }
    this.#watch(id, name, launched);
    this.#deps.audit("session.started", { session: id, folder: start.projectDir, by: "chat" });
    this.#deps.log("new.started", { session: id, claude: launched.pid });
    return { started: true, text: TEXTS.started(name) };
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

  #folders(): string[] {
    return this.#deps.sessions
      .folders()
      .filter((dir) => this.#offers(dir))
      .slice(0, MOST_FOLDERS);
  }

  /**
   * A folder /new may start a session in: served for terminal sessions, which these are, showing
   * Claude's text (not ping-only: its messages are what the session is for), and still a folder.
   */
  #offers(dir: string): boolean {
    const { config } = this.#deps;
    if (!sessionScope(config, { projectDir: dir, entrypoint: "cli" }).served) return false;
    if (contentModeFor(config, dir) !== "full") return false;
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  }

  /** Sessions started here that still run, or haven't reported yet. */
  #running(): number {
    const alive = this.#deps.alive ?? processAlive;
    return this.#deps.sessions
      .open()
      .filter(
        (session) => session.fromChat && (session.claudePid === 0 || alive(session.claudePid)),
      ).length;
  }
}

/** A folder's key in its button: the start of its SHA-256, within Telegram's 64 bytes. */
function keyOf(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

/** Each folder's name: its own, or with its parent's where two share one. */
function folderNames(dirs: readonly string[]): string[] {
  const names = dirs.map((dir) => basename(dir));
  return dirs.map((dir, at) => {
    const name = names[at] ?? dir;
    const twins = names.filter((other) => other === name).length > 1;
    return twins ? `${basename(dirname(dir))}/${name}` : name;
  });
}
