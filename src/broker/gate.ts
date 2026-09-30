import type { Log } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { CallbackQuery, Chat, Update, User } from "../shared/telegram/types.ts";
import { type CommandAnswer, type CommandName, parseCommand } from "./commands.ts";
import type { IncomingReply } from "./inbox.ts";
import type { Pairing, PairingResult } from "./pairing.ts";

export interface GateDeps {
  readonly telegram: Pick<TelegramClient, "sendMessage">;
  readonly pairing: Pairing;
  readonly log: Log;
  /** Carries out a command of the paired user (/status, /away…) and returns the answer. */
  readonly command: (name: CommandName) => string | CommandAnswer;
  /** Answers the paired user's press of a button, such as 📄 (plan 2.7). */
  readonly press: (data: string, chat: number, queryId: string) => Promise<void>;
  /** Routes a reply for Claude, which the poller stored before the offset moved on (plan 3.1). */
  readonly reply: (updateId: number) => Promise<void>;
  /** Someone just paired from `chat`: its menu of commands (plan 7.1). */
  readonly paired: (chat: number) => void;
}

const REPLIES = {
  paired:
    "Paired ✅\nThis chat now gets the bridge's messages from Claude Code on your Mac, " +
    "and only you can answer them. /help shows how.",
  cancelled:
    "❌ Too many wrong codes, so this pairing is cancelled. " +
    "Run 'bun run ctl pair' on your Mac to start again.",
} as const;

/**
 * Decides what happens to each update (design §5). `/pair <code>` in a private chat pairs its sender.
 * After that only the paired user, in a private chat, is heard: their commands are answered and their
 * text goes to Claude as a reply; everything else is dropped and logged, with ids only, never text.
 */
export async function handleUpdate(update: Update, deps: GateDeps): Promise<void> {
  if (update.kind === "other") return drop(update, deps, "not a message or a button press");
  const { from, chat, text } = parts(update);
  if (from === undefined) return drop(update, deps, "no sender");
  if (from.is_bot) return drop(update, deps, "sent by a bot");
  if (chat?.type !== "private") return drop(update, deps, "not a private chat");
  const code = text === undefined ? undefined : pairArgument(text);
  if (code !== undefined) return pair(update, code, from, chat, deps);
  const paired = deps.pairing.pairedUser();
  if (paired === undefined) return drop(update, deps, "not paired yet");
  if (paired.id !== from.id) return drop(update, deps, "not the paired user");
  if (update.kind === "callback_query") return pressed(update.callback_query, chat, deps);
  const command = text === undefined ? undefined : parseCommand(text);
  if (command !== undefined) return answer(update, command, chat, deps);
  if (replyOf(update, paired.id) !== undefined) {
    deps.log("reply.received", { update: update.update_id });
    return deps.reply(update.update_id);
  }
  deps.log("update.accepted", { update: update.update_id, kind: update.kind });
}

/**
 * A reply for Claude (flow 4): a text message from the paired user in a private chat. A command, known
 * or not (such as /start), never is.
 */
export function replyOf(update: Update, paired: number | undefined): IncomingReply | undefined {
  if (update.kind !== "message" || paired === undefined) return undefined;
  const { message } = update;
  const text = message.text;
  if (message.from?.id !== paired || message.from.is_bot || message.chat.type !== "private") {
    return undefined;
  }
  if (text === undefined || text.trim() === "" || text.trimStart().startsWith("/"))
    return undefined;
  return {
    updateId: update.update_id,
    chatId: message.chat.id,
    messageId: message.message_id,
    replyTo: message.reply_to_message_id,
    text,
  };
}

async function pressed(query: CallbackQuery, chat: Chat, deps: GateDeps) {
  const data = query.data ?? "";
  // Only the kind of button is logged: "full" from "full:<id>".
  deps.log("button", { kind: data.split(":")[0] ?? "" });
  await deps.press(data, chat.id, query.id);
}

async function answer(update: Known, name: CommandName, chat: Chat, deps: GateDeps) {
  deps.log("command", { update: update.update_id, command: name });
  const answered = deps.command(name);
  const body = typeof answered === "string" ? { text: answered } : answered;
  await deps.telegram.sendMessage({ chat_id: chat.id, ...body });
}

type Known = Exclude<Update, { kind: "other" }>;

interface Parts {
  readonly from: User | undefined;
  readonly chat: Chat | undefined;
  readonly text: string | undefined;
}

function parts(update: Known): Parts {
  if (update.kind === "callback_query") {
    const { from, message } = update.callback_query;
    return { from, chat: message?.chat, text: undefined };
  }
  const { from, chat, text } = update.message;
  return { from, chat, text };
}

/** The code after `/pair` (or `/pair@SomeBot`), "" if none; undefined if it isn't a /pair command. */
function pairArgument(text: string): string | undefined {
  const match = /^\/pair(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : undefined;
}

async function pair(update: Known, code: string, from: User, chat: Chat, deps: GateDeps) {
  const name =
    from.username === undefined ? from.first_name : `${from.first_name} (@${from.username})`;
  const result = deps.pairing.attempt(code, { id: from.id, name });
  deps.log("pairing.attempt", { update: update.update_id, from: from.id, outcome: result.outcome });
  const reply = replyTo(result);
  // With no pairing in progress, a /pair gets no answer, like any other stranger's message.
  if (reply !== undefined) await deps.telegram.sendMessage({ chat_id: chat.id, text: reply });
  if (result.outcome === "paired") deps.paired(chat.id);
}

function replyTo(result: PairingResult): string | undefined {
  switch (result.outcome) {
    case "paired":
      return REPLIES.paired;
    case "cancelled":
      return REPLIES.cancelled;
    case "wrong": {
      const tries = result.attemptsLeft === 1 ? "1 try" : `${result.attemptsLeft} tries`;
      return `❌ Wrong code: ${tries} left. Or run 'bun run ctl pair' on your Mac for a new one.`;
    }
    case "none":
      return undefined;
  }
}

function drop(update: Update, deps: GateDeps, reason: string): void {
  const known = update.kind === "other" ? undefined : parts(update);
  deps.log("update.dropped", {
    update: update.update_id,
    kind: update.kind,
    from: known?.from?.id ?? 0,
    chat: known?.chat?.id ?? 0,
    chatType: known?.chat?.type ?? "",
    reason,
  });
}
