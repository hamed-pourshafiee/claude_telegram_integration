/** A delimiter row's cell: hyphens, with a colon at either end for how its column is aligned. */
const DELIMITER = /^:?-+:?$/;
/** Emoji and East Asian wide characters take two columns in a monospace font. */
const WIDE =
  /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;
/** A code span or bold text in a cell. */
const MARKED = /`([^`]+)`|\*\*(?=\S)(.*?\S)\*\*/g;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

type Align = "left" | "right" | "center";

/**
 * A Markdown table with its columns lined up, for a monospace block (D8): Claude doesn't pad its cells.
 * It's drawn as psql draws one. Code and bold marks in cells go, as the block can't show them. Rows that
 * aren't a table (a header row, then a delimiter row with as many cells) stay as written.
 */
export function alignedTable(rows: readonly string[]): readonly string[] {
  const [header, delimiter, ...body] = rows.map(cellsOf);
  if (header === undefined || delimiter === undefined || !delimits(delimiter, header)) return rows;
  const aligns = delimiter.map(alignOf);
  const table = [header, ...body].map((cells) => cells.map((cell) => cell.replace(MARKED, "$1$2")));
  const widths = Array.from({ length: Math.max(...table.map((cells) => cells.length)) }, (_, at) =>
    Math.max(...table.map((cells) => columns(cells[at] ?? ""))),
  );
  // No pipes at either end: an emoji, drawn a little wider than two columns, then shifts nothing after
  // it when it's in the last column, where Claude puts most of them.
  const line = (cells: readonly string[]) =>
    widths
      .map((width, at) => pad(cells[at] ?? "", width, aligns[at] ?? "left"))
      .join(" | ")
      .trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("-+-");
  const [head = [], ...rest] = table;
  return [line(head), rule, ...rest.map(line)];
}

/** Whether `row` is a table's delimiter row: hyphens, and maybe colons, under each header cell. */
function delimits(row: readonly string[], header: readonly string[]): boolean {
  return row.length === header.length && row.every((cell) => DELIMITER.test(cell));
}

/** A row's cells, split at the pipes that aren't escaped; the pipes at either end are optional. */
function cellsOf(row: string): string[] {
  const inner = row.trim().replace(/^\||(?<!\\)\|$/g, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function alignOf(delimiter: string): Align {
  if (!delimiter.endsWith(":")) return "left";
  return delimiter.startsWith(":") ? "center" : "right";
}

function pad(cell: string, width: number, align: Align): string {
  const room = width - columns(cell);
  if (align === "right") return " ".repeat(room) + cell;
  if (align === "left") return cell + " ".repeat(room);
  return " ".repeat(Math.floor(room / 2)) + cell + " ".repeat(Math.ceil(room / 2));
}

/** How many columns `text` takes in a monospace font. */
function columns(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += WIDE.test(segment) ? 2 : 1;
  return width;
}
