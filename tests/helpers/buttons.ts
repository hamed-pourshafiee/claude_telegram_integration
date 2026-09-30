import type { InlineKeyboardButton, SendMessageParams } from "../../src/shared/telegram/types.ts";

/** The buttons under a message the broker sent, row by row; none under a reply box (ForceReply). */
export function buttonRows(
  params: SendMessageParams | undefined,
): readonly InlineKeyboardButton[][] {
  const markup = params?.reply_markup;
  return markup !== undefined && "inline_keyboard" in markup
    ? markup.inline_keyboard.map((row) => [...row])
    : [];
}
