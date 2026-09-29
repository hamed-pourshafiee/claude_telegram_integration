import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { Ask, Asks } from "./asks.ts";
import { escapeHtml } from "./format.ts";
import { askNotice, waitingNotice } from "./notices.ts";
import type { Notifier } from "./notifier.ts";
import { questionButtons } from "./questions.ts";
import type { Session } from "./sessions.ts";

export interface AskMessagesDeps {
  readonly asks: Asks;
  readonly notifier: Pick<Notifier, "post" | "send">;
  readonly telegram: Pick<
    TelegramClient,
    "sendMessage" | "editMessageText" | "editMessageReplyMarkup"
  >;
  readonly log: Log;
}

/** How a call left Telegram, as its messages then say. */
export type Settled = "moved" | "withdrawn" | "lost";

const SETTLED: Readonly<Record<Settled, string>> = {
  moved: "🖥 Moved to the Mac: answer it there.",
  withdrawn: "⏹ No longer asked: Claude stopped waiting at the Mac.",
  lost: "⚠️ Claude stopped waiting before your answers went in, so they weren't used.",
};
/** Telegram's limit for a message's text. */
const MAX_TEXT = 4096;
/** An answer shown under its question is cut to this. */
const ANSWER_SHOWN = 200;

/**
 * The questions' messages in the chat (plan 4.1): one per question, with its buttons, then edited as
 * things happen, which Telegram does silently. Each message's text is kept, so it can be edited after a
 * broker restart too.
 */
export class AskMessages {
  readonly #deps: AskMessagesDeps;

  constructor(deps: AskMessagesDeps) {
    this.#deps = deps;
  }

  /** Sends each question of a call to `chat`, in order, with its buttons. */
  async post(ask: Ask, session: Session, chat: number): Promise<void> {
    const { asks, notifier } = this.#deps;
    const input = ask.input;
    if (input === undefined) return;
    for (const [index, question] of input.questions.entries()) {
      const rows = questionButtons(ask.id, index, question, []);
      const posted = await notifier.post(
        chat,
        "question",
        session,
        (name) => askNotice(name, input, index),
        rows,
      );
      const last = posted.at(-1);
      if (last !== undefined) {
        asks.shown(ask.id, index, { chatId: chat, messageId: last.messageId, html: last.html });
      }
    }
  }

  /** A question answered here: its message shows the answer, and its buttons go. */
  answered(ask: Ask, index: number, answer: string): Promise<void> {
    const shown = answer.length > ANSWER_SHOWN ? `${answer.slice(0, ANSWER_SHOWN)}…` : answer;
    return this.#addLine(ask.id, index, `✅ ${shown}`);
  }

  /** A multi-select's picks so far, as its toggles show them. */
  async picked(ask: Ask, index: number, picked: readonly number[]): Promise<void> {
    const question = ask.input?.questions[index];
    const asked = this.#deps.asks.questions(ask.id)[index];
    if (question === undefined || asked?.chatId === undefined || asked.messageId === undefined) {
      return;
    }
    const inline_keyboard = questionButtons(ask.id, index, question, picked);
    await this.#deps.telegram.editMessageReplyMarkup({
      chat_id: asked.chatId,
      message_id: asked.messageId,
      reply_markup: { inline_keyboard },
    });
  }

  /**
   * The call left Telegram: each of its messages says how, and loses its buttons. Answers that never
   * went in are also announced (D7): an edit alone makes no sound.
   */
  async settled(ask: Ask, how: Settled): Promise<void> {
    const questions = this.#deps.asks.questions(ask.id);
    await Promise.all(questions.map((asked) => this.#addLine(ask.id, asked.index, SETTLED[how])));
    const last = questions.at(-1);
    if (how !== "lost" || last?.chatId === undefined) return;
    const thread =
      last.messageId === undefined ? {} : { reply_parameters: { message_id: last.messageId } };
    await this.#deps.telegram.sendMessage({ chat_id: last.chatId, text: SETTLED.lost, ...thread });
  }

  /** ❓ a call open in the dialog at the Mac, while you're away (flow 3); whether it went out. */
  tellWaiting(ask: Ask, session: Session): Promise<boolean> {
    return this.#deps.notifier.send("question", session, (name, mode) =>
      waitingNotice(name, ask.input, mode),
    );
  }

  /** A line added under a question's message, whose buttons go. */
  async #addLine(askId: string, index: number, line: string): Promise<void> {
    const { asks, telegram, log } = this.#deps;
    const asked = asks.questions(askId)[index];
    if (asked?.chatId === undefined || asked.messageId === undefined) return;
    const target = { chat_id: asked.chatId, message_id: asked.messageId };
    const html = `${asked.html}\n\n${escapeHtml(line)}`;
    if (asked.html === "" || html.length > MAX_TEXT) {
      // Its text is gone or too long to grow: the buttons go, at least.
      await telegram.editMessageReplyMarkup(target);
      log("ask.buttons-removed", { ask: askId, index });
      return;
    }
    // Without reply_markup, the edit also removes the buttons.
    const quiet = { link_preview_options: { is_disabled: true } };
    await telegram.editMessageText({ ...target, text: html, parse_mode: "HTML", ...quiet });
    asks.shown(askId, index, { chatId: asked.chatId, messageId: asked.messageId, html });
  }
}
