import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { Outbox } from "./outbox.ts";
import { type Doing, emojiOf, type Listed, listed, type SessionListDeps } from "./session-list.ts";

export interface WriteToDeps extends SessionListDeps {
  readonly telegram: Pick<TelegramClient, "sendMessage" | "answerCallbackQuery">;
  readonly outbox: Pick<Outbox, "link">;
  readonly log: Log;
}

const BUTTON = /^write:([\w-]{1,40})$/;
/** The most characters of the reply box's placeholder. */
const PLACEHOLDER_CHARS = 64;

const TEXTS = {
  gone: "That session isn't open any more.",
  idle: "That session has stopped: it takes a message again once it's used at the Mac.",
  failed: "The reply box didn't open. Try again.",
} as const;

/**
 * A tap on a session under /sessions (plan 7.4). The bot asks for your message with Telegram's reply box
 * open on its question, which is linked to the session: what you send is a reply to it, and goes to that
 * session like a reply to its ✅ (flow 4), now or when its turn ends. A session that stopped, ended or
 * whose Claude has gone since the list was sent gets a note instead.
 */
export async function writeTo(
  data: string,
  chat: number,
  queryId: string,
  deps: WriteToDeps,
): Promise<void> {
  const id = BUTTON.exec(data)?.[1];
  const row = id === undefined ? undefined : listed(deps).find((one) => one.session.id === id);
  const answer = (text?: string) =>
    deps.telegram.answerCallbackQuery({
      callback_query_id: queryId,
      ...(text === undefined ? {} : { text }),
    });
  if (row === undefined || row.doing.kind === "idle") {
    deps.log("write.refused", { known: row !== undefined, doing: row?.doing.kind ?? "none" });
    return answer(row === undefined ? TEXTS.gone : TEXTS.idle);
  }
  try {
    await ask(chat, row, deps);
  } catch (error) {
    deps.log("write.failed", { session: row.session.id, error: messageOf(error) });
    return answer(TEXTS.failed);
  }
  return answer();
}

/** The question, with the reply box open on it, linked to the session. */
async function ask(chat: number, { session, doing, name }: Listed, deps: WriteToDeps) {
  const placeholder = Array.from(`Message for ${name}`).slice(0, PLACEHOLDER_CHARS).join("");
  const sent = await deps.telegram.sendMessage({
    chat_id: chat,
    text: `✏️ Your message for ${emojiOf(doing)} ${name}\n${whatHappens(doing)}`,
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  });
  deps.outbox.link(chat, sent.message_id, {
    sessionId: session.id,
    generation: session.generation,
    kind: "write",
  });
  deps.log("write.asked", { session: session.id, doing: doing.kind });
}

/** What your message does, by what the session is doing (flow 4). */
function whatHappens(doing: Doing): string {
  switch (doing.kind) {
    case "listening":
      return "It goes in at once, and Claude carries on.";
    case "asks":
      if (doing.ask.input?.permission !== undefined) {
        return "It denies the permission it asks for, with your message as the reason.";
      }
      return doing.ask.input?.plan === undefined
        ? "It answers the question it asks."
        : "It tells Claude what to change in the plan.";
    case "at-mac":
      return "Something waits at the Mac: your message goes in when this turn ends.";
    case "working":
      return "It's working: your message goes in when this turn ends.";
    case "idle":
      return TEXTS.idle;
  }
}
