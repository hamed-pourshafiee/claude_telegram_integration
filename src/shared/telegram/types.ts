import { asFields } from "../json.ts";

// The parts of the Telegram Bot API (core.telegram.org/bots/api) that the bridge uses. Answers are
// checked as they arrive, so the rest of the code can rely on these shapes.

export interface User {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

export interface Chat {
  readonly id: number;
  /** "private", "group", "supergroup" or "channel". */
  readonly type: string;
}

export interface Message {
  readonly message_id: number;
  readonly date: number;
  readonly chat: Chat;
  readonly from?: User;
  readonly text?: string;
  /** The message_id of the message this one replies to. */
  readonly reply_to_message_id?: number;
}

export interface CallbackQuery {
  readonly id: string;
  readonly from: User;
  readonly data?: string;
  /** The bot's message whose button was pressed. */
  readonly message?: { readonly message_id: number; readonly chat: Chat };
}

/** An update by kind. Any other kind, or a malformed one, is "other": it only moves the offset on. */
export type Update =
  | { readonly update_id: number; readonly kind: "message"; readonly message: Message }
  | {
      readonly update_id: number;
      readonly kind: "callback_query";
      readonly callback_query: CallbackQuery;
    }
  | { readonly update_id: number; readonly kind: "other" };

export interface InlineKeyboardButton {
  readonly text: string;
  /** At most 64 bytes. */
  readonly callback_data: string;
}

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface ReplyParameters {
  readonly message_id: number;
  readonly allow_sending_without_reply?: boolean;
}

export interface GetUpdatesParams {
  readonly offset?: number;
  /** Seconds Telegram holds the request open while there is nothing new (long polling). */
  readonly timeout?: number;
  readonly limit?: number;
}

export interface SendMessageParams {
  readonly chat_id: number;
  readonly text: string;
  readonly parse_mode?: "HTML";
  readonly reply_parameters?: ReplyParameters;
  readonly reply_markup?: InlineKeyboardMarkup;
  readonly link_preview_options?: { readonly is_disabled: boolean };
  readonly disable_notification?: boolean;
}

export interface EditMessageTextParams {
  readonly chat_id: number;
  readonly message_id: number;
  readonly text: string;
  readonly parse_mode?: "HTML";
  readonly reply_markup?: InlineKeyboardMarkup;
  readonly link_preview_options?: { readonly is_disabled: boolean };
}

export interface AnswerCallbackQueryParams {
  readonly callback_query_id: string;
  readonly text?: string;
  readonly show_alert?: boolean;
}

/** A text sent as a file (text/markdown), for replies too long for a message. */
export interface SendDocumentParams {
  readonly chat_id: number;
  readonly filename: string;
  readonly content: string;
  readonly caption?: string;
  readonly parse_mode?: "HTML";
  readonly reply_parameters?: ReplyParameters;
}

export function parseUser(value: unknown): User | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const { id, is_bot, first_name, username } = fields;
  if (typeof id !== "number" || typeof is_bot !== "boolean" || typeof first_name !== "string") {
    return undefined;
  }
  return { id, is_bot, first_name, ...(typeof username === "string" ? { username } : {}) };
}

export function parseChat(value: unknown): Chat | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const { id, type } = fields;
  return typeof id === "number" && typeof type === "string" ? { id, type } : undefined;
}

/** A message, or undefined if a field the bridge relies on is missing or of the wrong type. */
export function parseMessage(value: unknown): Message | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const { message_id, date, text } = fields;
  const chat = parseChat(fields.chat);
  const from = parseUser(fields.from);
  const replyTo = asFields(fields.reply_to_message)?.message_id;
  if (typeof message_id !== "number" || typeof date !== "number" || !chat) return undefined;
  if ((fields.from !== undefined && !from) || (text !== undefined && typeof text !== "string")) {
    return undefined;
  }
  return {
    message_id,
    date,
    chat,
    ...(from ? { from } : {}),
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof replyTo === "number" ? { reply_to_message_id: replyTo } : {}),
  };
}

export function parseCallbackQuery(value: unknown): CallbackQuery | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const { id, data } = fields;
  const from = parseUser(fields.from);
  const message = asFields(fields.message);
  const chat = parseChat(message?.chat);
  const messageId = message?.message_id;
  if (typeof id !== "string" || !from || (data !== undefined && typeof data !== "string")) {
    return undefined;
  }
  return {
    id,
    from,
    ...(typeof data === "string" ? { data } : {}),
    ...(chat && typeof messageId === "number" ? { message: { message_id: messageId, chat } } : {}),
  };
}

/** Undefined only without an update_id, when not even the offset can move past it. */
export function parseUpdate(value: unknown): Update | undefined {
  const fields = asFields(value);
  const update_id = fields?.update_id;
  if (!fields || typeof update_id !== "number") return undefined;
  const message = parseMessage(fields.message);
  if (message) return { update_id, kind: "message", message };
  const callback_query = parseCallbackQuery(fields.callback_query);
  if (callback_query) return { update_id, kind: "callback_query", callback_query };
  return { update_id, kind: "other" };
}

/** Telegram's answer envelope: `result` when ok, else the error's code, description and retry_after. */
export interface Answer {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: number;
  readonly description?: string;
  readonly retryAfter?: number;
}

/** Telegram's answer envelope, or undefined when the body is not one (a proxy's HTML page, say). */
export function parseAnswer(text: string): Answer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined; // not JSON: the caller reports an unexpected answer with the HTTP status
  }
  const fields = asFields(value);
  if (!fields || typeof fields.ok !== "boolean") return undefined;
  if (fields.ok) return { ok: true, result: fields.result };
  const { error_code, description } = fields;
  const retryAfter = asFields(fields.parameters)?.retry_after;
  return {
    ok: false,
    ...(typeof error_code === "number" ? { code: error_code } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof retryAfter === "number" ? { retryAfter } : {}),
  };
}
