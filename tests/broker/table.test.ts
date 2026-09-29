import { describe, expect, test } from "bun:test";
import { alignedTable } from "../../src/broker/table.ts";

// D8: a table goes as a monospace block with its columns lined up, since Claude doesn't pad its cells,
// drawn as psql draws one: no pipes at either end, so that an emoji in the last column shifts nothing.
describe("alignedTable", () => {
  test("the live check's table lines up, an emoji taking two columns", () => {
    const claude = [
      "| File | Status |",
      "|------|--------|",
      "| hello.py | ✅ committed |",
      "| ok.py | ✅ committed |",
    ];
    expect(alignedTable(claude)).toEqual([
      "File     | Status",
      "---------+-------------",
      "hello.py | ✅ committed",
      "ok.py    | ✅ committed",
    ]);
  });

  test("columns aligned right or centred; code and bold marks go; a short row gets empty cells", () => {
    const table = [
      "| Name | Tests | Note |",
      "|:-----|------:|:----:|",
      "| `app.ts` | 12 | **new** |",
      "| x | 3 |",
    ];
    expect(alignedTable(table)).toEqual([
      "Name   | Tests | Note",
      "-------+-------+-----",
      "app.ts |    12 | new",
      "x      |     3 |",
    ]);
  });

  test("an escaped pipe stays inside its cell", () => {
    expect(alignedTable(["| a \\| b | c |", "|---|---|"])).toEqual(["a \\| b | c", "-------+--"]);
  });

  test("rows that aren't a table stay as written", () => {
    const notTables = [
      ["| a line that starts with a pipe"],
      ["| a | b |", "| c | d |"],
      ["| a | b |", "|---|"],
    ];
    for (const rows of notTables) expect(alignedTable(rows)).toBe(rows);
  });
});
