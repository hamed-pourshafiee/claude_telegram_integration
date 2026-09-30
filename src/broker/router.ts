import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { InlineKeyboardButton } from "../shared/telegram/types.ts";
import type { AskChat, Target } from "./ask-chat.ts";
import type { Inbox, StoredReply } from "./inbox.ts";
import type { Outbox } from "./outbox.ts";
import type { Relay } from "./relay.ts";
import { label, labels, type Sessions } from "./sessions.ts";
import type { Waiters } from "./waiters.ts";

export interface RouterDeps {
  readonly relay: Pick<Relay, "deliver">;
  readonly waiters: Pick<Waiters, "listening">;
  /** Claude's questions waiting in the chat, which a typed reply may answer (plan 4.1). */
  readonly asks: Pick<AskChat, "questionAt" | "asking" | "answerText">;
  readonly inbox: Inbox;
  readonly outbox: Pick<Outbox, "find">;
  readonly sessions: Pick<Sessions, "get">;
  readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  readonly log: Log;
  readonly now?: () => number;
}

/** How long the picker's buttons work (flow 4): an answer after that, or a second one, is refused. */
export const PICK_MS = 10 * 60_000;
const BUTTON = /^(to|drop):(\d{1,15})(?::([\w-]{1,40}))?$/;

const TEXTS = {
  nobody:
    "Nobody is waiting for a reply right now, so this wasn't delivered. To leave a message for a busy " +
    "session, reply to one of its messages.",
  ask: "Several sessions are waiting. Which one is this for?",
  ended: (name: string) => `${name} has ended, so this wasn't delivered.`,
  queued: (name: string) => `🕓 ${name} is busy. This goes in when it stops next.`,
  closed: "That question is no longer open, so this wasn't used.",
  expired: "That choice has expired: nothing was sent.",
  dropped: "Not sent.",
  sent: (name: string) => `Sent to ${name}.`,
} as const;

/** What to send after a routing decision, in the thread of the reply it is about. */
type Note =
  | { readonly kind: "say"; readonly reply: StoredReply; readonly text: string }
  | { readonly kind: "ask"; readonly reply: StoredReply; readonly sessions: readonly string[] };

/** Where a reply went, and what you're told of it (nothing when it simply arrived). */
interface Given {
  readonly outcome: string;
  readonly text: string | undefined;
}

/**
 * Where a reply from Telegram goes (flow 4, plans 3.2 and 4.1). A reply-to one of Claude's questions
 * answers it; a reply-to another of the bot's notices goes to that notice's session. A plain message
 * goes to the only session waiting for a reply or asking a question; with several the bot asks which,
 * and with none it says so. A session that is busy keeps the reply queued for its next stop, and one
 * that asks takes it as the answer to its first open question. Every decision is made at once, in the
 * database; only the messages about it are sent afterwards.
 */
export class Router {
  readonly #deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  /** Routes a stored reply; a repeated or already routed one is left alone. */
  async route(updateId: number): Promise<void> {
    await this.#send(this.#decide(updateId));
  }

  /** At start: replies a crash left unrouted are routed, all before the poller takes new ones. */
  async recover(): Promise<void> {
    const notes = this.#deps.inbox.inState("new").map((reply) => this.#decide(reply.updateId));
    await Promise.all(notes.map((note) => this.#send(note)));
  }

  /** A press of a picker button: the reply goes where you chose, once, while the choice is open. */
  async press(data: string, queryId: string): Promise<void> {
    const { inbox, log } = this.#deps;
    const match = BUTTON.exec(data);
    const reply = match === null ? undefined : inbox.get(Number(match[2]));
    const now = this.#deps.now?.() ?? Date.now();
    if (match === null || reply?.state !== "choosing" || now - reply.receivedAt >= PICK_MS) {
      if (reply?.state === "choosing") inbox.mark(reply.updateId, "unrouted");
      log("picker.refused", { known: reply !== undefined, state: reply?.state ?? "none" });
      return this.#answer(queryId, TEXTS.expired);
    }
    if (match[1] === "drop") {
      inbox.mark(reply.updateId, "unrouted");
      log("picker.dropped", { update: reply.updateId });
      return this.#answer(queryId, TEXTS.dropped);
    }
    const sessionId = match[3] ?? "";
    const given = this.#give(reply, sessionId);
    log("picker.chosen", { update: reply.updateId, session: sessionId, outcome: given.outcome });
    return this.#answer(queryId, given.text ?? TEXTS.sent(this.#name(sessionId)));
  }

  #decide(updateId: number): Note | undefined {
    const { inbox, outbox, asks, log } = this.#deps;
    const reply = inbox.get(updateId);
    if (reply?.state !== "new") return undefined;
    if (reply.replyTo !== undefined) {
      const question = asks.questionAt(reply.chatId, reply.replyTo);
      if (question !== undefined) return this.#say(reply, this.#toQuestion(reply, question));
      const link = outbox.find(reply.chatId, reply.replyTo);
      if (link !== undefined) return this.#say(reply, this.#give(reply, link.sessionId));
    }
    const sessions = this.#waiting();
    const [only] = sessions;
    if (only !== undefined && sessions.length === 1)
      return this.#say(reply, this.#give(reply, only));
    if (sessions.length > 1) {
      inbox.mark(updateId, "choosing");
      log("reply.asked", { update: updateId, waiting: sessions.length });
      return { kind: "ask", reply, sessions };
    }
    inbox.mark(updateId, "unrouted");
    log("reply.unrouted", { update: updateId, reason: "nobody listening" });
    return { kind: "say", reply, text: TEXTS.nobody };
  }

  /** Sessions a plain message may be for: waiting for a reply, or asking in the chat. */
  #waiting(): string[] {
    const listening = this.#deps.waiters.listening().map((waiter) => waiter.sessionId);
    return [...new Set([...listening, ...this.#deps.asks.asking()])];
  }

  /** Gives the reply to a session: the answer to its open question, or a reply for its waiter. */
  #give(reply: StoredReply, sessionId: string): Given {
    if (this.#deps.asks.asking().includes(sessionId)) return this.#toQuestion(reply, { sessionId });
    const outcome = this.#deps.relay.deliver(sessionId, [reply.updateId]);
    this.#deps.log("reply.routed", { update: reply.updateId, session: sessionId, outcome });
    if (outcome === "handed") return { outcome, text: undefined };
    if (outcome === "ended") this.#deps.inbox.mark(reply.updateId, "unrouted");
    const text = outcome === "ended" ? TEXTS.ended : TEXTS.queued;
    return { outcome, text: text(this.#name(sessionId)) };
  }

  /** The reply as the answer to a question; a number out of range asks for another. */
  #toQuestion(reply: StoredReply, target: Target): Given {
    const typed = this.#deps.asks.answerText(target, reply.text);
    this.#deps.log("reply.answer", { update: reply.updateId, outcome: typed.outcome });
    const answered = typed.outcome === "answered";
    this.#deps.inbox.mark(reply.updateId, answered ? "delivered" : "unrouted");
    if (answered) return { outcome: typed.outcome, text: undefined };
    return {
      outcome: typed.outcome,
      text: typed.outcome === "invalid" ? typed.text : TEXTS.closed,
    };
  }

  #say(reply: StoredReply, given: Given): Note | undefined {
    return given.text === undefined ? undefined : { kind: "say", reply, text: given.text };
  }

  async #send(note: Note | undefined): Promise<void> {
    if (note === undefined) return;
    const { reply } = note;
    const thread = { chat_id: reply.chatId, reply_parameters: { message_id: reply.messageId } };
    try {
      if (note.kind === "say") {
        await this.#deps.telegram.sendMessage({ ...thread, text: note.text });
        return;
      }
      const found = note.sessions.flatMap((sessionId) => this.#deps.sessions.get(sessionId) ?? []);
      const names = labels(found);
      const rows: InlineKeyboardButton[][] = found.map((session, at) => [
        { text: names[at] ?? "", callback_data: `to:${reply.updateId}:${session.id}` },
      ]);
      rows.push([{ text: "Don't send it", callback_data: `drop:${reply.updateId}` }]);
      const reply_markup = { inline_keyboard: rows };
      await this.#deps.telegram.sendMessage({ ...thread, text: TEXTS.ask, reply_markup });
    } catch (error) {
      this.#deps.log("reply.note-failed", { update: reply.updateId, error: messageOf(error) });
    }
  }

  async #answer(queryId: string, text: string): Promise<void> {
    await this.#deps.telegram.answerCallbackQuery({ callback_query_id: queryId, text });
  }

  #name(sessionId: string): string {
    const session = this.#deps.sessions.get(sessionId);
    return session === undefined ? "That session" : label(session);
  }
}
