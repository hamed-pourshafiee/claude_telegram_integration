import { alignedTable } from "./table.ts";

/** Telegram's HTML mode needs these three escaped in text (Bot API, formatting options). */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type Block =
  | { readonly kind: "text"; readonly line: string }
  | { readonly kind: "code"; readonly lang: string; readonly lines: readonly string[] }
  | { readonly kind: "table"; readonly lines: readonly string[] };

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const TABLE_ROW = /^\s*\|/;
/** Inline code, and links [label](url); the rest of a line is plain text. */
const TOKEN = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
/** Emphasis never contains a tag, so the tags it adds always nest. */
const BOLD = /\*\*(?=[^\s*])([^*<>\n]*?[^\s*])\*\*/g;
const STRIKE = /~~(?=\S)([^~<>\n]*?\S)~~/g;
const ITALIC = /(^|[^\w*])\*(?=[^\s*])([^*<>\n]*?[^\s*])\*(?![\w*])/g;
const UNDERSCORED = /(^|[\s(])_(?=[^\s_])([^_<>\n]*?[^\s_])_(?=$|[\s),:;!?])/g;
/**
 * A path (with a slash) or a file name (with an extension that starts with a letter), set as code so
 * Telegram doesn't turn it into a link: hello.py is a domain name in Paraguay.
 */
const PATH =
  /(^|[\s(])((?:~|\.{1,2})?\/?[\w@-][\w.@-]*(?:\/[\w.@-]*[\w@-])+\/?|[\w@-]+(?:\.[\w@-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s),:;!?]|\.(?:\s|$))/g;

/**
 * Claude's Markdown as Telegram HTML (D8, decided 2026-09-29), in whole units: a line of text, a code
 * block or a table. Every unit closes the tags it opens and is at most `limit` long, so messages can be
 * packed from units without breaking the markup. The text must be redacted already.
 */
export function renderUnits(text: string, limit: number): string[] {
  return blocksOf(text).flatMap((block) => {
    if (block.kind === "text") return fit(renderLine(block.line), block.line, limit);
    const open =
      block.kind === "code" && block.lang ? `<pre><code class="language-${block.lang}">` : "<pre>";
    const close = open === "<pre>" ? "</pre>" : "</code></pre>";
    // Lined up before escaping, so that "&lt;" counts as the one column it shows.
    const lines = block.kind === "table" ? alignedTable(block.lines) : block.lines;
    return preUnits(lines, open, close, limit);
  });
}

function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  for (let at = 0; at < lines.length; ) {
    const line = lines[at] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      for (at += 1; at < lines.length && !FENCE_END.test(lines[at] ?? ""); at += 1) {
        body.push(lines[at] ?? "");
      }
      // Past the closing fence; a reply cut inside a code block has none, and ends in code.
      at += 1;
      blocks.push({ kind: "code", lang: fence[1] ?? "", lines: body });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      for (; at < lines.length && TABLE_ROW.test(lines[at] ?? ""); at += 1)
        rows.push(lines[at] ?? "");
      blocks.push({ kind: "table", lines: rows });
      continue;
    }
    blocks.push({ kind: "text", line });
    at += 1;
  }
  return blocks;
}

/** One line of text: a heading goes bold, a list item gets a bullet, a rule a dash; then inline marks. */
export function renderLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
  if (heading !== null) return `<b>${inline(heading[1] ?? "")}</b>`;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return "———";
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet !== null) return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`;
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote !== null) return `┃ ${inline(quote[1] ?? "")}`;
  return inline(line);
}

function inline(text: string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    html += plain(text.slice(last, match.index));
    const [whole, code, label, url] = match;
    if (code !== undefined) html += `<code>${escapeHtml(code)}</code>`;
    else html += link(label ?? "", url ?? "");
    last = match.index + whole.length;
  }
  return html + plain(text.slice(last));
}

/** A web link stays a link; any other target, such as a file of the repo, is shown as code. */
function link(label: string, url: string): string {
  if (!/^https?:\/\//i.test(url)) return `<code>${escapeHtml(label)}</code>`;
  return `<a href="${escapeHtml(url).replaceAll('"', "&quot;")}">${escapeHtml(label)}</a>`;
}

function plain(text: string): string {
  const marked = escapeHtml(text)
    .replace(BOLD, "<b>$1</b>")
    .replace(STRIKE, "<s>$1</s>")
    .replace(ITALIC, "$1<i>$2</i>")
    .replace(UNDERSCORED, "$1<i>$2</i>");
  // Paths only in the text between tags.
  return marked
    .split(/(<[^>]+>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PATH, pathAsCode)))
    .join("");
}

function pathAsCode(match: string, before: string, path: string): string {
  // "e.g" and "i.e" look like file names; nothing that short is one.
  if (/^[A-Za-z]\.[A-Za-z]$/.test(path)) return match;
  return `${before}<code>${path}</code>`;
}

/** A rendered line that is too long for a message: its text escaped and cut into pieces that fit. */
function fit(html: string, line: string, limit: number): string[] {
  if (html.length <= limit) return [html];
  const pieces: string[] = [];
  for (let rest = escapeHtml(line); rest.length > 0; ) {
    let end = Math.min(limit, rest.length);
    // Not inside an escape such as &amp;, nor between the halves of an emoji.
    const amp = rest.lastIndexOf("&", end - 1);
    if (amp > end - 6 && rest.indexOf(";", amp) >= end) end = amp;
    if (end < rest.length && isHighSurrogate(rest.charCodeAt(end - 1))) end -= 1;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return pieces;
}

/** A code block or table as <pre> units that each fit, cut between lines (or inside a very long one). */
function preUnits(lines: readonly string[], open: string, close: string, limit: number): string[] {
  const room = limit - open.length - close.length;
  const units: string[] = [];
  let body = "";
  for (const line of lines.flatMap((each) => fit(escapeHtml(each), each, room))) {
    const next = body === "" ? line : `${body}\n${line}`;
    if (next.length > room && body !== "") {
      units.push(`${open}${body}${close}`);
      body = line;
    } else {
      body = next;
    }
  }
  if (body !== "" || units.length === 0) units.push(`${open}${body}${close}`);
  return units;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
