import { escapeHtml, renderUnits } from "./markdown.ts";
import { redact } from "./redact.ts";

export { escapeHtml } from "./markdown.ts";

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
 * file, its Markdown rendered as Telegram formatting (decided 2026-09-29), under a bold header, and
 * packed into messages Telegram accepts, each a run of whole lines, code blocks or tables.
 */
export function formatReply(header: string, body: string, maxChars: number): Reply {
  const { text, count } = redact(body);
  const shown = text.length > maxChars ? text.slice(0, cutPoint(text, maxChars)) : text;
  const cut = shown.length < text.length;
  const head = `<b>${escapeHtml(header.slice(0, HEADER_LIMIT))}</b>`;
  // Room for any unit in the first message too, after the header and its blank line.
  const room = MESSAGE_LIMIT - head.length - 2;
  const units = shown.trim() === "" ? [] : renderUnits(shown.trimEnd(), room);
  if (cut) units.push("", `✂️ ${shown.length} of ${text.length} characters shown.`);
  if (units.length === 0) return { messages: [head], fullText: undefined, redacted: 0 };
  return { messages: pack(head, units), fullText: cut ? text : undefined, redacted: count };
}

/** Units into messages of at most MESSAGE_LIMIT, one unit per line; the first opens with the header. */
function pack(head: string, units: readonly string[]): string[] {
  const messages: string[] = [];
  let current = `${head}\n`;
  for (const unit of units) {
    if (current.length + 1 + unit.length > MESSAGE_LIMIT) {
      messages.push(current);
      current = unit;
      continue;
    }
    current = `${current}\n${unit}`;
  }
  messages.push(current);
  return messages;
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
