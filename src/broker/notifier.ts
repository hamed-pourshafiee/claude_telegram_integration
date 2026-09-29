import { basename } from "node:path";
import type { Config, ContentMode } from "../shared/config.ts";
import type { Log } from "../shared/log.ts";
import { contentModeFor } from "../shared/scope.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { InlineKeyboardMarkup } from "../shared/telegram/types.ts";
import { formatReply } from "./format.ts";
import type { FullTexts } from "./full-texts.ts";
import type { Notice } from "./notices.ts";
import type { Pairing } from "./pairing.ts";
import type { Presence } from "./presence.ts";
import { label, type Session } from "./sessions.ts";

export interface NotifierDeps {
  readonly telegram: Pick<
    TelegramClient,
    "sendMessage" | "sendDocument" | "answerCallbackQuery" | "editMessageText"
  >;
  readonly pairing: Pick<Pairing, "pairedUser">;
  readonly presence: Pick<Presence, "snapshot">;
  readonly config: Config;
  readonly log: Log;
  readonly fullTexts: FullTexts;
  /** Records a sent notice, so a reply-to it finds its session (flow 4, plan 3.2). */
  readonly link?: (chatId: number, messageId: number, session: Session, kind: string) => void;
}

/** Builds a notice from the session's label and how much of its text may leave the Mac (D8). */
export type NoticeOf = (label: string, mode: ContentMode) => Notice;

const BUTTON_DATA = /^full:([0-9a-f]{16})$/;
/** How long a ✅'s last message is kept for the "continued at the computer" edit, and how many. */
const KEEP_MS = 24 * 60 * 60_000;
const MAX_KEPT = 100;
const CONTINUED = "\n\n↩️ continued at the computer";
/** Telegram's limit for a message's text. */
const MAX_TEXT = 4096;

/** A ✅'s last message as sent, kept in memory only (D8), so typing at the Mac can edit it. */
interface Sent {
  readonly chat: number;
  readonly messageId: number;
  readonly text: string;
  readonly markup: InlineKeyboardMarkup | undefined;
  readonly until: number;
}

/**
 * Sends notices to the paired user's chat, only while they are away and haven't muted the bridge
 * (flow 1, D4). Text is redacted and cut by the formatter (D8); a cut reply gets a 📄 button that sends
 * the whole of it as a file.
 */
export class Notifier {
  readonly #deps: NotifierDeps;
  /** By session and generation. */
  readonly #finishes = new Map<string, Sent>();

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
  }

  /** The chat a notice goes to now, or why none does. */
  target(): { readonly chat: number } | { readonly skip: string } {
    const user = this.#deps.pairing.pairedUser();
    if (user === undefined) return { skip: "not paired" };
    const { mode, state } = this.#deps.presence.snapshot();
    if (mode === "off") return { skip: "muted" };
    if (state !== "away") return { skip: state === "active" ? "at the Mac" : "in between" };
    return { chat: user.id };
  }

  /** Sends the notice for `session` if you are away; whether it went out. */
  async send(kind: string, session: Session, noticeOf: NoticeOf): Promise<boolean> {
    const { config, log, telegram } = this.#deps;
    const target = this.target();
    if ("skip" in target) {
      log("notice.skipped", { kind, session: session.id, reason: target.skip });
      return false;
    }
    const mode = contentModeFor(config, session.projectDir);
    const notice = noticeOf(label(session), mode);
    const reply = formatReply(notice.header, notice.body, config.content.maxChars);
    const button = reply.fullText === undefined ? undefined : this.#button(reply.fullText, session);
    for (const [index, text] of reply.messages.entries()) {
      const markup = index === reply.messages.length - 1 && button ? { reply_markup: button } : {};
      const quiet = { link_preview_options: { is_disabled: true } };
      const sent = await telegram.sendMessage({
        chat_id: target.chat,
        text,
        parse_mode: "HTML",
        ...quiet,
        ...markup,
      });
      this.#deps.link?.(target.chat, sent.message_id, session, kind);
      if (kind === "finish" && index === reply.messages.length - 1) {
        this.#keep(session, {
          chat: target.chat,
          messageId: sent.message_id,
          text,
          markup: button,
        });
      }
    }
    const cut = reply.fullText !== undefined;
    const counts = { messages: reply.messages.length, redacted: reply.redacted, cut, mode };
    log("notice.sent", { kind, session: session.id, ...counts });
    return true;
  }

  /** A press of a 📄 button: the full text as a .md file, or why it is gone. */
  async press(data: string, chat: number, queryId: string): Promise<void> {
    const { telegram, fullTexts, log } = this.#deps;
    const id = BUTTON_DATA.exec(data)?.[1];
    const kept = id === undefined ? undefined : fullTexts.get(id);
    if (kept === undefined) {
      const text = "That text is no longer kept: a day at most, and not across a broker restart.";
      await telegram.answerCallbackQuery({ callback_query_id: queryId, text, show_alert: true });
      log("button.gone", { known: id !== undefined });
      return;
    }
    await telegram.answerCallbackQuery({ callback_query_id: queryId });
    await telegram.sendDocument({ chat_id: chat, filename: kept.filename, content: kept.text });
    log("button.full-text", { chars: kept.text.length });
  }

  /**
   * You typed at the Mac while that stop's hook waited (flow 2, plan 3.3): its ✅ is edited to say so,
   * silently (Telegram doesn't notify an edit). Nothing to edit if none went out, or the broker restarted.
   */
  async continuedAtMac(sessionId: string, generation: number): Promise<void> {
    const key = `${sessionId}#${generation}`;
    const sent = this.#finishes.get(key);
    this.#finishes.delete(key);
    if (sent === undefined || sent.until <= Date.now()) return;
    if (sent.text.length + CONTINUED.length > MAX_TEXT) return;
    await this.#deps.telegram.editMessageText({
      chat_id: sent.chat,
      message_id: sent.messageId,
      text: `${sent.text}${CONTINUED}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(sent.markup === undefined ? {} : { reply_markup: sent.markup }),
    });
    this.#deps.log("notice.continued", { session: sessionId, generation });
  }

  #keep(session: Session, sent: Omit<Sent, "until">): void {
    this.#finishes.set(`${session.id}#${session.generation}`, {
      ...sent,
      until: Date.now() + KEEP_MS,
    });
    for (const old of this.#finishes.keys()) {
      if (this.#finishes.size <= MAX_KEPT) break;
      this.#finishes.delete(old);
    }
  }

  #button(fullText: string, session: Session): InlineKeyboardMarkup {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const filename = `${basename(session.projectDir)}-${session.id.slice(0, 4)}-${stamp}.md`;
    const id = this.#deps.fullTexts.put(fullText, filename);
    return { inline_keyboard: [[{ text: "📄 Full text as a file", callback_data: `full:${id}` }]] };
  }
}
