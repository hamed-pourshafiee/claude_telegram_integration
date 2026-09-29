import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { InlineKeyboardButton } from "../shared/telegram/types.ts";
import type { Inbox, StoredReply } from "./inbox.ts";
import type { Outbox } from "./outbox.ts";
import type { Relay } from "./relay.ts";
import { label, type Sessions } from "./sessions.ts";
import type { Waiter, Waiters } from "./waiters.ts";

export interface RouterDeps {
  readonly relay: Pick<Relay, "deliver">;
  readonly waiters: Pick<Waiters, "listening">;
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
  expired: "That choice has expired: nothing was sent.",
  dropped: "Not sent.",
  sent: (name: string) => `Sent to ${name}.`,
} as const;

/** What to send after a routing decision, in the thread of the reply it is about. */
type Note =
  | { readonly kind: "say"; readonly reply: StoredReply; readonly text: string }
  | { readonly kind: "ask"; readonly reply: StoredReply; readonly listening: readonly Waiter[] };

/**
 * Where a reply from Telegram goes (flow 4, plan 3.2). A reply-to one of the bot's notices goes to that
 * notice's session. A plain message goes to the only session waiting; with several the bot asks which,
 * and with none it says so. A session that is busy keeps the reply queued for its next stop. Every
 * decision is made at once, in the database; only the messages about it are sent afterwards.
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
    const outcome = this.#deps.relay.deliver(sessionId, [reply.updateId]);
    log("picker.chosen", { update: reply.updateId, session: sessionId, outcome });
    const name = this.#name(sessionId);
    if (outcome === "ended") inbox.mark(reply.updateId, "unrouted");
    const text = { ended: TEXTS.ended, queued: TEXTS.queued, handed: TEXTS.sent }[outcome](name);
    return this.#answer(queryId, text);
  }

  #decide(updateId: number): Note | undefined {
    const { inbox, outbox, waiters, log } = this.#deps;
    const reply = inbox.get(updateId);
    if (reply?.state !== "new") return undefined;
    const link = reply.replyTo === undefined ? undefined : outbox.find(reply.chatId, reply.replyTo);
    if (link !== undefined) return this.#toSession(reply, link.sessionId);
    const listening = waiters.listening();
    const [only] = listening;
    if (only !== undefined && listening.length === 1) return this.#toSession(reply, only.sessionId);
    if (listening.length > 1) {
      inbox.mark(updateId, "choosing");
      log("reply.asked", { update: updateId, listening: listening.length });
      return { kind: "ask", reply, listening };
    }
    inbox.mark(updateId, "unrouted");
    log("reply.unrouted", { update: updateId, reason: "nobody listening" });
    return { kind: "say", reply, text: TEXTS.nobody };
  }

  #toSession(reply: StoredReply, sessionId: string): Note | undefined {
    const outcome = this.#deps.relay.deliver(sessionId, [reply.updateId]);
    this.#deps.log("reply.routed", { update: reply.updateId, session: sessionId, outcome });
    if (outcome === "handed") return undefined;
    if (outcome === "ended") this.#deps.inbox.mark(reply.updateId, "unrouted");
    const text = outcome === "ended" ? TEXTS.ended : TEXTS.queued;
    return { kind: "say", reply, text: text(this.#name(sessionId)) };
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
      const rows: InlineKeyboardButton[][] = note.listening.map((waiter) => [
        {
          text: this.#name(waiter.sessionId),
          callback_data: `to:${reply.updateId}:${waiter.sessionId}`,
        },
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
