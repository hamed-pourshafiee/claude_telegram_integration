import { describe, expect, test } from "bun:test";
import { formatReply, MESSAGE_LIMIT } from "../../src/broker/format.ts";
import { renderLine, renderUnits } from "../../src/broker/markdown.ts";

// D8, decided 2026-09-29: Claude's Markdown as Telegram formatting, file names as code.
const units = (text: string, limit = 3000) => renderUnits(text, limit);

/** Whether every tag closes, in order: Telegram refuses a message whose tags don't nest. */
function balanced(html: string): boolean {
  const open: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (close === "") open.push(name ?? "");
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

describe("inline marks", () => {
  test("bold, italic, strikethrough and inline code", () => {
    expect(renderLine("**Done:** the *tests* pass, ~~not~~ `bun test <x>` ok")).toBe(
      "<b>Done:</b> the <i>tests</i> pass, <s>not</s> <code>bun test &lt;x&gt;</code> ok",
    );
    expect(renderLine("an _underlined_ word")).toBe("an <i>underlined</i> word");
  });

  test("a web link stays a link; a link to a file is shown as code", () => {
    expect(renderLine("see [the docs](https://example.com/a?b=1&c=2)")).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2">the docs</a>',
    );
    expect(renderLine("I created [hello.py](hello.py).")).toBe("I created <code>hello.py</code>.");
  });

  test("file names and paths are code, so Telegram doesn't make links of them", () => {
    expect(renderLine("Changed src/broker/app.ts, hello.py and __init__.py in ~/src/x.")).toBe(
      "Changed <code>src/broker/app.ts</code>, <code>hello.py</code> and " +
        "<code>__init__.py</code> in <code>~/src/x</code>.",
    );
    expect(renderLine("**hello.py** is new")).toBe("<b><code>hello.py</code></b> is new");
  });

  test("left as written: versions, e.g., snake_case, math, a bare URL", () => {
    const line = "Claude Code 2.1.283, e.g. snake_case, 2 * 3 * 4, https://example.com/x.py";
    expect(renderLine(line)).toBe(line);
  });

  test("text is escaped", () => {
    expect(renderLine("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("lines and blocks", () => {
  test("a heading goes bold; list items get bullets; a quote, a rule", () => {
    expect(units("## Result\n- one\n  * two\n> note\n---")).toEqual([
      "<b>Result</b>",
      "• one",
      "  • two",
      "┃ note",
      "———",
    ]);
  });

  test("a code block is one unit, in its language, escaped; a table keeps its columns", () => {
    expect(units("Before:\n```ts\nconst a = 1 < 2;\n\nlet b;\n```\nAfter.")).toEqual([
      "Before:",
      '<pre><code class="language-ts">const a = 1 &lt; 2;\n\nlet b;</code></pre>',
      "After.",
    ]);
    expect(units("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
      "<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>",
    ]);
  });

  test("a reply cut inside a code block ends in code", () => {
    expect(units("Here:\n```\nline one\nline two")).toEqual([
      "Here:",
      "<pre>line one\nline two</pre>",
    ]);
  });
});

describe("markup Telegram accepts", () => {
  const tricky = [
    "*a **b** c*",
    "**a *b** c*",
    "**unclosed bold and `code`",
    "~~a **b** c~~ and _x *y* z_",
    "[a **bold** link](https://example.com) and [x](y.md)",
    "**[link](https://example.com)** then *`code`*",
    "path/with_under_scores/file.test.ts and *emph file.py*",
    "<b>not a tag</b> & <i>",
    // Different marks that cross: each emphasis must stop short of the other's tags.
    "~~a **b~~ c**",
    "_a **b_ c**",
    "*a ~~b* c~~",
  ];

  test("tags always nest, whatever the Markdown", () => {
    for (const line of tricky) expect(balanced(renderLine(line))).toBe(true);
  });

  test("a code block or a line too long for a message is split into units that fit", () => {
    const code = `\`\`\`\n${Array.from({ length: 300 }, (_, i) => `line ${i} & more`).join("\n")}\n\`\`\``;
    const long = `${"word & ".repeat(900)}end`;
    for (const unit of units(`${code}\n${long}`, 1000)) {
      expect(unit.length).toBeLessThanOrEqual(1000);
      expect(balanced(unit)).toBe(true);
      expect(/&[a-z]*$/.test(unit)).toBe(false);
    }
  });

  test("a formatted reply: every message fits, and its tags nest", () => {
    const body = [...tricky, "```js", "x".repeat(5000), "```", ...tricky].join("\n");
    const { messages } = formatReply("✅ repo", body, 100_000);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      expect(balanced(message)).toBe(true);
    }
  });
});
