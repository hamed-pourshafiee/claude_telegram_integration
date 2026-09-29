import { describe, expect, test } from "bun:test";
import { escapeHtml, formatReply, MESSAGE_LIMIT } from "../../src/broker/format.ts";
import { redact } from "../../src/broker/redact.ts";
import { SAMPLES } from "../helpers/secret-samples.ts";

const htmlToText = (html: string) =>
  html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

describe("redaction (plan 2.5's fixture: one sample of each secret family)", () => {
  const fixture = SAMPLES.map((sample) => sample.line).join("\n");

  test("no secret survives, and each family is named where it was", () => {
    const { text, count } = redact(fixture);
    for (const sample of SAMPLES) {
      expect(text).not.toContain(sample.secret);
      expect(text).toContain(`[redacted ${sample.family}]`);
    }
    expect(count).toBe(SAMPLES.length);
  });

  test("what should stay stays: names, prefixes and task-notification", () => {
    const { text } = redact(fixture);
    for (const sample of SAMPLES) if (sample.kept) expect(text).toContain(sample.kept);
  });

  test("ordinary text is left alone", () => {
    const prose = [
      "Ran 241 tests across 20 files; the task-notification arrived at 12:34:56.",
      "The task-notification-received-event fired twice.",
      'const TOKEN_KEY = "TELEGRAM_BOT_TOKEN";',
      "See https://core.telegram.org/bots/api#sendmessage for the 4096 limit.",
    ].join("\n");
    expect(redact(prose)).toEqual({ text: prose, count: 0 });
  });

  test("the formatted reply holds no secret either, in the chat or in the full text", () => {
    const reply = formatReply("✅ repo · session", `${"x".repeat(4000)}\n${fixture}`, 3500);
    const everything = [...reply.messages, reply.fullText ?? ""].join("\n");
    for (const sample of SAMPLES) expect(htmlToText(everything)).not.toContain(sample.secret);
    expect(reply.redacted).toBe(SAMPLES.length);
  });
});

describe("messages Telegram accepts", () => {
  const long = Array.from(
    { length: 400 },
    (_, i) => `line ${i}: a < b && c > d 🙂🎉 ${"é".repeat(20)}`,
  )
    .join("\n")
    .repeat(3);

  test("no message exceeds 4096 characters, and nothing is lost or doubled", () => {
    const { messages, fullText } = formatReply("✅ header", long, 100_000);
    expect(fullText).toBeUndefined();
    expect(messages.length).toBeGreaterThan(3);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    // Messages break between lines, so the line break between two of them is the one lost.
    const joined = htmlToText(messages.join("\n")).replace("<b>✅ header</b>\n\n", "");
    expect(joined).toBe(long);
  });

  test("no message is cut inside an emoji or an escape", () => {
    for (const message of formatReply("h", long, 100_000).messages) {
      expect(/[\uD800-\uDBFF]$/.test(message)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(message)).toBe(false);
      expect(/&[a-z]*$/.test(message)).toBe(false);
    }
  });

  test("text is escaped; only the header is bold", () => {
    const { messages } = formatReply("repo <main> & co", "use <b>bold</b> & more", 3500);
    expect(messages).toEqual([
      "<b>repo &lt;main&gt; &amp; co</b>\n\nuse &lt;b&gt;bold&lt;/b&gt; &amp; more",
    ]);
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("the cap (D8)", () => {
  test("a long reply shows about maxChars characters and keeps the full text for the file", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const { messages, fullText } = formatReply("✅ repo", body, 3500);
    expect(messages).toHaveLength(1);
    expect(fullText).toBe(body);
    const shown = htmlToText(messages[0] ?? "");
    expect(shown).toMatch(/✂️ \d+ of \d+ characters shown\.$/);
    const count = Number(/✂️ (\d+) of/.exec(shown)?.[1]);
    expect(count).toBeGreaterThan(2800);
    expect(count).toBeLessThanOrEqual(3500);
  });

  test("a reply under the cap is sent whole, with no file", () => {
    const { messages, fullText } = formatReply("✅ repo", "Done: 3 files changed.", 3500);
    expect(messages).toEqual(["<b>✅ repo</b>\n\nDone: 3 files changed."]);
    expect(fullText).toBeUndefined();
  });
});
