import { redact } from "./redact.ts";

/** The most a Telegram message may hold (Bot API, sendMessage). */
export const MESSAGE_LIMIT = 4096;
const HEADER_LIMIT = 200;

/** A reply ready for Telegram (D8). */
export interface Reply {
  /** The messages to send with parse_mode HTML, in order; none is longer than MESSAGE_LIMIT. */
  readonly messages: readonly string[];
  /** The whole reply, redacted, when the chat shows only its start; it goes out as a file on request. */
  readonly fullText: string | undefined;
  /** How many secrets were masked. */
  readonly redacted: number;
}

/**
 * A reply for Telegram (D8): the body redacted, then cut near `maxChars` with the full text kept for a
 * file, HTML-escaped under a bold header, and split into messages Telegram accepts.
 */
export function formatReply(header: string, body: string, maxChars: number): Reply {
  const { text, count } = redact(body);
  const shown = text.length > maxChars ? text.slice(0, cutPoint(text, maxChars)) : text;
  const cut = shown.length < text.length;
  const note = cut ? `\n\n✂️ ${shown.length} of ${text.length} characters shown.` : "";
  const head = `<b>${escapeHtml(header.slice(0, HEADER_LIMIT))}</b>\n\n`;
  const pieces = split(shown + note, MESSAGE_LIMIT - head.length, MESSAGE_LIMIT);
  if (pieces.length === 0) return { messages: [head.trimEnd()], fullText: undefined, redacted: 0 };
  const messages = pieces.map((piece, index) => (index === 0 ? head : "") + escapeHtml(piece));
  return { messages, fullText: cut ? text : undefined, redacted: count };
}

/** Telegram's HTML mode needs these three escaped in text (Bot API, formatting options). */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Splits `text` into pieces whose escaped form fits: the first in `firstLimit`, the others in `limit`.
 * It cuts after a line break or a space near the end when there is one, and never inside an emoji.
 */
export function split(text: string, firstLimit: number, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const end = fitting(rest, pieces.length === 0 ? firstLimit : limit);
    if (end === 0) throw new Error(`split: a limit of ${limit} leaves no room`);
    const at = end >= rest.length ? end : cutPoint(rest, end);
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return pieces;
}

/** How long a start of `text` fits in `max` once escaped, without splitting a surrogate pair. */
function fitting(text: string, max: number): number {
  let size = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const code = text.charCodeAt(index);
    const units = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    const width = char === "&" ? 5 : char === "<" || char === ">" ? 4 : units;
    if (size + width > max) return index;
    size += width;
    index += units;
  }
  return index;
}

/** Where to cut `text` at or before `end`: after the last line break or space in the last fifth. */
function cutPoint(text: string, end: number): number {
  const safeEnd = isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
  const from = Math.floor(safeEnd * 0.8);
  const window = text.slice(from, safeEnd);
  const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  return breakAt >= 0 ? from + breakAt + 1 : safeEnd;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
