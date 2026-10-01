import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Config } from "../shared/config.ts";
import { messageOf } from "../shared/errors.ts";
import { contentModeFor, sessionScope } from "../shared/scope.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import { type BackgroundDeps, BackgroundSessions, type Started } from "./background-sessions.ts";
import type { CommandAnswer } from "./commands.ts";
import type { SessionRef } from "./sessions.ts";
import type { Start, Starts } from "./starts.ts";
import { type OpenTab, type PendingTab, PendingTabs, TAB_ENTRYPOINT } from "./vscode-tab.ts";
import type { VsWindow } from "./vscode-windows.ts";

export interface NewSessionsDeps extends BackgroundDeps {
  readonly starts: Pick<Starts, "record" | "use">;
  readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  readonly config: Config;
  /** The windows VS Code has open (F28): /new offers their folders. */
  readonly windows: () => readonly VsWindow[];
  /** Opens a new Claude Code tab in a window (plan 7.8). */
  readonly openTab: OpenTab;
  /** The paired user's first name, for the mark on the first message. */
  readonly senderName: () => string | null;
  /** How long a message waits for its tab, in ms; 30 s unless a test says otherwise. */
  readonly tabMs?: number;
}

export type { Started } from "./background-sessions.ts";

/** How long a message waits for its tab before the session runs in the background (D11). */
const TAB_MS = 30_000;
/** The most windows /new offers. */
const MOST_WINDOWS = 8;
/** The most characters of the reply box's placeholder. */
const PLACEHOLDER_CHARS = 64;
const BUTTON = /^new:([0-9a-f]{16})$/;

const TEXTS = {
  which:
    "🖥 A new session: in which VS Code window?\nIt opens there as a new Claude tab, starts on your first message and reports here.",
  none: "No VS Code window is open whose folder the bridge serves, so there's nowhere to start a session.",
  gone: "That window isn't open any more.",
  expired: "That question has expired, so nothing was started. Send /new again.",
  taken: "A session was already started from that question.",
  failed: "The reply box didn't open. Try again.",
  ask: (name: string) =>
    `✏️ Your first message for a new session in ${name}\nThe session starts when you send it.`,
  opening: (name: string) =>
    `🖥 Opening a new Claude tab in ${name}. It starts on your message; its messages come here, and your replies go to it.`,
  noTab: (name: string) =>
    `⚠️ No Claude tab started in ${name}, so the session runs in the background instead. Its messages still come here.`,
} as const;

/**
 * /new (D11, plans 7.7 and 7.8): you pick one of the windows VS Code has open and write the first
 * message in the reply box. The broker opens a new Claude Code tab in that window, and the tab's
 * SessionStart hook gets the message, which starts it working (F30). With no tab in 30 s, the broker runs
 * `claude -p` in the window's folder instead. Either way the session's hooks send its messages here like
 * any session's, and your replies continue it.
 */
export class NewSessions {
  readonly #deps: NewSessionsDeps;
  readonly #tabs = new PendingTabs();
  readonly #background: BackgroundSessions;

  constructor(deps: NewSessionsDeps) {
    this.#deps = deps;
    this.#background = new BackgroundSessions(deps);
  }

  /** The answer to /new: a button for each window whose folder is offered. */
  answer(): CommandAnswer {
    const windows = this.#windows();
    if (windows.length === 0) return { text: TEXTS.none };
    const names = windowNames(windows);
    const inline_keyboard = windows.map((window, at) => [
      { text: `🖥 ${names[at] ?? window.name}`, callback_data: `new:${keyOf(window.folder)}` },
    ]);
    return { text: TEXTS.which, reply_markup: { inline_keyboard } };
  }

  /** A tap on a window: the question for the first message, with the reply box open on it. */
  async press(data: string, chat: number, queryId: string): Promise<void> {
    const key = BUTTON.exec(data)?.[1];
    const windows = this.#windows();
    const at = windows.findIndex((window) => keyOf(window.folder) === key);
    const window = windows[at];
    const toast = (text?: string) =>
      this.#deps.telegram.answerCallbackQuery({
        callback_query_id: queryId,
        ...(text === undefined ? {} : { text }),
      });
    if (window === undefined) return toast(TEXTS.gone);
    const name = windowNames(windows)[at] ?? window.name;
    try {
      const placeholder = Array.from(`First message for ${name}`).slice(0, PLACEHOLDER_CHARS);
      const sent = await this.#deps.telegram.sendMessage({
        chat_id: chat,
        text: TEXTS.ask(name),
        reply_markup: { force_reply: true, input_field_placeholder: placeholder.join("") },
      });
      this.#deps.starts.record(chat, sent.message_id, window.folder);
    } catch (error) {
      this.#deps.log("new.ask-failed", { error: messageOf(error) });
      return toast(TEXTS.failed);
    }
    this.#deps.log("new.asked", {});
    return toast();
  }

  /**
   * A reply to a /new question: a new tab opens in its window, to start on the reply (plan 7.8). A
   * window closed since gets the session in the background, in its folder (plan 7.7).
   */
  start(text: string, start: Start): Started {
    const window = this.#deps.windows().find((open) => open.folder === start.projectDir);
    const name = window?.name ?? basename(start.projectDir);
    const taken = this.#deps.starts.use(start);
    if (taken !== "used") {
      return { started: false, text: taken === "expired" ? TEXTS.expired : TEXTS.taken };
    }
    if (!this.#offers(start.projectDir)) return { started: false, text: TEXTS.gone };
    const message = `📨 From ${this.#deps.senderName() ?? "the user"} on Telegram: ${text}`;
    if (window === undefined) {
      return this.#background.start({ folder: start.projectDir, name, message, addDirs: [] });
    }
    this.#openTab({ window, folder: this.#resolved(window.folder), name, message });
    return { started: true, text: TEXTS.opening(name) };
  }

  /**
   * A session's SessionStart (F30): a new VS Code tab in a folder where a message waits takes the one
   * that has waited longest, and is recorded as started from the chat. Any other session gets nothing.
   */
  claim(ref: SessionRef, source: string): string | undefined {
    if (this.#tabs.size === 0 || source !== "startup" || ref.entrypoint !== TAB_ENTRYPOINT) {
      return undefined;
    }
    const tab = this.#tabs.take(ref.projectDir);
    if (tab === undefined) {
      this.#deps.log("new.tab-elsewhere", { session: ref.id, folder: ref.projectDir });
      return undefined;
    }
    this.#deps.sessions.startedHere(ref, "tab");
    this.#deps.audit("session.started", {
      session: ref.id,
      folder: tab.window.folder,
      by: "chat",
      in: "tab",
    });
    this.#deps.log("new.tab-started", { session: ref.id });
    return tab.message;
  }

  /** Opens the tab; with none in time, or when it can't open, the session runs in the background. */
  #openTab(tab: PendingTab): void {
    const { log, openTab, tabMs } = this.#deps;
    this.#tabs.add(tab, tabMs ?? TAB_MS, (late) => this.#noTab(late, "no tab started"));
    openTab(tab.window).then(
      () => log("new.tab-opened", {}),
      (error: unknown) => {
        log("new.tab-failed", { error: messageOf(error) });
        if (this.#tabs.remove(tab)) this.#noTab(tab, "the tab didn't open");
      },
    );
  }

  /** No tab took the message: the session runs in the background instead, and you hear of it. */
  #noTab(tab: PendingTab, why: string): void {
    this.#deps.log("new.no-tab", { why });
    const { window, name, message } = tab;
    let started: Started;
    try {
      started = this.#background.start({
        folder: window.folder,
        name,
        message,
        addDirs: window.addDirs,
      });
    } catch (error) {
      this.#deps.log("new.background-failed", { error: messageOf(error) });
      started = this.#background.failed(name, error);
    }
    this.#deps.tell(started.started ? TEXTS.noTab(name) : started.text).catch((error: unknown) => {
      this.#deps.log("new.tell-failed", { error: messageOf(error) });
    });
  }

  #windows(): VsWindow[] {
    return this.#deps
      .windows()
      .filter((window) => this.#offers(window.folder))
      .slice(0, MOST_WINDOWS);
  }

  /**
   * A folder /new may start a session in: served (whatever the entrypoint, as its session's hooks will
   * find it: F27), showing Claude's text, since its messages are what it's for, and still a folder.
   */
  #offers(dir: string): boolean {
    const { config } = this.#deps;
    if (!sessionScope(config, { projectDir: dir, entrypoint: undefined }, true).served)
      return false;
    if (contentModeFor(config, dir) !== "full") return false;
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  }

  /** A folder as the hooks name it (resolved, F15); as it is, logged, when it can't be resolved. */
  #resolved(dir: string): string {
    try {
      return realpathSync(dir);
    } catch (error) {
      this.#deps.log("new.unresolved", { error: messageOf(error) });
      return dir;
    }
  }
}

/** A folder's key in its button: the start of its SHA-256, within Telegram's 64 bytes. */
function keyOf(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

/** Each window's name: its own, or with its folder's parent where two share one. */
function windowNames(windows: readonly VsWindow[]): string[] {
  return windows.map((window) => {
    const twins = windows.filter((other) => other.name === window.name).length > 1;
    return twins ? `${basename(dirname(window.folder))}/${window.name}` : window.name;
  });
}
