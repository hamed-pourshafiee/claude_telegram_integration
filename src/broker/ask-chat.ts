import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { AskMessages } from "./ask-messages.ts";
import type { AskRelay } from "./ask-relay.ts";
import type { Ask, Asks } from "./asks.ts";
import type { Presence, Snapshot, State } from "./presence.ts";
import { parsePress, pickedAnswer, type Question, typedAnswer } from "./questions.ts";
import type { Sessions } from "./sessions.ts";

export interface AskChatDeps {
  readonly asks: Asks;
  readonly relay: Pick<AskRelay, "release" | "completed">;
  readonly messages: Pick<AskMessages, "answered" | "picked" | "tellWaiting">;
  readonly sessions: Pick<Sessions, "get">;
  readonly presence: Pick<Presence, "snapshot">;
  readonly telegram: Pick<TelegramClient, "answerCallbackQuery">;
  readonly log: Log;
}

/** Which question a typed answer is for: the one replied to, or a session's first open one. */
export type Target =
  | { readonly askId: string; readonly index: number }
  | { readonly sessionId: string };

/** What became of a typed answer. */
export type Typed =
  | { readonly outcome: "answered" }
  | { readonly outcome: "invalid"; readonly text: string }
  | { readonly outcome: "closed" };

const TEXTS = {
  expired: "That question has expired.",
  pickFirst: "Pick at least one first, or reply to the question with your own answer.",
  moved: "🖥 Moved to the Mac.",
  none: "No question is waiting here.",
  handedBack: (count: number) =>
    `🖥 ${count === 1 ? "The question went" : `${count} questions went`} back to the Mac.`,
} as const;

/**
 * Your side of Claude's questions in the chat (plan 4.1): buttons, typed answers and /local, and flow
 * 3's moves: a call in the chat goes to the Mac at your first touch, and one left open in the dialog
 * there is reported once you're away.
 */
export class AskChat {
  readonly #deps: AskChatDeps;

  constructor(deps: AskChatDeps) {
    this.#deps = deps;
  }

  /** A press of a question's button: an option, a multi-select's Done, or "Answer at the Mac". */
  async press(data: string, queryId: string): Promise<void> {
    const press = parsePress(data);
    const ask = press === undefined ? undefined : this.#deps.asks.get(press.askId);
    if (press === undefined || ask?.state !== "remote" || ask.input === undefined) {
      this.#deps.log("ask.button-expired", {
        known: ask !== undefined,
        state: ask?.state ?? "none",
      });
      return this.#toast(queryId, TEXTS.expired);
    }
    if (press.kind === "mac") {
      this.#deps.relay.release(ask.id, "button");
      return this.#toast(queryId, TEXTS.moved);
    }
    const question = ask.input.questions[press.index];
    const asked = this.#deps.asks.questions(ask.id)[press.index];
    if (question === undefined || asked === undefined || asked.answer !== undefined) {
      return this.#toast(queryId, TEXTS.expired);
    }
    if (press.kind === "done") {
      if (asked.picked.length === 0) return this.#toast(queryId, TEXTS.pickFirst);
      return this.#finish(ask, press.index, pickedAnswer(question, asked.picked), queryId);
    }
    const option = question.options[press.option];
    if (option === undefined) return this.#toast(queryId, TEXTS.expired);
    if (!question.multiSelect) return this.#finish(ask, press.index, option.label, queryId);
    return this.#toggle(ask, press.index, asked.picked, press.option, queryId);
  }

  /** The question a message of the chat asks, while its call waits there. */
  questionAt(chatId: number, messageId: number): Target | undefined {
    const asked = this.#deps.asks.at(chatId, messageId);
    return asked === undefined ? undefined : { askId: asked.askId, index: asked.index };
  }

  /** Sessions with a call waiting in the chat, oldest first: a plain message may be for them. */
  asking(): string[] {
    return [...new Set(this.#deps.asks.inState(["remote"]).map((ask) => ask.sessionId))];
  }

  /** A typed answer (flow 4 routed it here): as typed, or a number in range for a number question. */
  answerText(target: Target, text: string): Typed {
    const { asks } = this.#deps;
    const ask =
      "askId" in target ? asks.get(target.askId) : asks.inState(["remote"], target.sessionId)[0];
    if (ask?.state !== "remote" || ask.input === undefined) return { outcome: "closed" };
    const open = asks.questions(ask.id).filter((asked) => asked.answer === undefined);
    const index = "index" in target ? target.index : open[0]?.index;
    const question: Question | undefined = ask.input.questions[index ?? -1];
    if (index === undefined || question === undefined) return { outcome: "closed" };
    const typed = typedAnswer(question, text);
    if ("problem" in typed) return { outcome: "invalid", text: typed.problem };
    return this.#record(ask, index, typed.answer) ? { outcome: "answered" } : { outcome: "closed" };
  }

  /** /local: every call waiting in the chat goes to the dialog at the Mac. The answer for the chat. */
  handBack(): string {
    const moved = this.#deps.asks
      .inState(["remote"])
      .filter((ask) => this.#deps.relay.release(ask.id, "/local"));
    return moved.length === 0 ? TEXTS.none : TEXTS.handedBack(moved.length);
  }

  /**
   * Presence changed (flow 3). Active again: calls in the chat go to the dialog at the Mac. Away: you
   * hear once of each call left open in the dialog, which no hook can answer.
   */
  presenceChanged(now: Snapshot, _before: State): void {
    if (now.state === "active") {
      for (const ask of this.#deps.asks.inState(["remote"])) {
        this.#deps.relay.release(ask.id, "back at the Mac");
      }
    }
    if (now.state === "away") {
      for (const ask of this.#deps.asks.inState(["local"])) if (!ask.told) this.#tellWaiting(ask);
    }
  }

  /** A call that went to the Mac at once: while you're away (a ping-only folder), you hear of it now. */
  localNow(ask: Ask): void {
    if (this.#deps.presence.snapshot().state === "away") this.#tellWaiting(ask);
  }

  async #finish(ask: Ask, index: number, answer: string, queryId: string): Promise<void> {
    if (!this.#record(ask, index, answer)) return this.#toast(queryId, TEXTS.expired);
    return this.#toast(queryId, undefined);
  }

  /** Records an answer and shows it; the last one completes the call. Whether it was taken. */
  #record(ask: Ask, index: number, answer: string): boolean {
    const outcome = this.#deps.asks.answer(ask.id, index, answer);
    this.#deps.log("ask.answer", { ask: ask.id, index, outcome, chars: answer.length });
    if (outcome === "closed") return false;
    this.#deps.messages.answered(ask, index, answer).catch((error: unknown) => {
      this.#deps.log("ask.edit-failed", { ask: ask.id, error: messageOf(error) });
    });
    if (outcome === "complete") this.#deps.relay.completed(ask.id);
    return true;
  }

  async #toggle(ask: Ask, index: number, picked: readonly number[], option: number, id: string) {
    const next = picked.includes(option)
      ? picked.filter((each) => each !== option)
      : [...picked, option].sort((a, b) => a - b);
    if (!this.#deps.asks.pick(ask.id, index, next)) return this.#toast(id, TEXTS.expired);
    await this.#toast(id, undefined);
    await this.#deps.messages.picked(ask, index, next);
  }

  #tellWaiting(ask: Ask): void {
    const session = this.#deps.sessions.get(ask.sessionId);
    if (session === undefined) return;
    this.#deps.asks.setTold(ask.id);
    this.#deps.messages.tellWaiting(ask, session).then(
      (sent) => this.#deps.log("ask.told-waiting", { ask: ask.id, sent }),
      (error: unknown) =>
        this.#deps.log("ask.tell-failed", { ask: ask.id, error: messageOf(error) }),
    );
  }

  async #toast(queryId: string, text: string | undefined): Promise<void> {
    const params = text === undefined ? {} : { text };
    await this.#deps.telegram.answerCallbackQuery({ callback_query_id: queryId, ...params });
  }
}
