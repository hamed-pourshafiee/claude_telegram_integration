import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { type AskHarness, askHarness, CHAT, SESSION } from "../helpers/asks.ts";
import { until } from "../helpers/wait.ts";

// Plan 4.1: your answers to Claude's questions, by button and by reply: single choice, multi-select
// (one joined string), your own answer, text and number questions, and buttons that have expired.
const dir = mkdtempSync(join(tmpdir(), "tg-ask-chat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const fresh = () => {
  files += 1;
  return askHarness(join(dir, `asks-${files}.db`));
};

const TOOLS = {
  questions: [
    {
      question: "Which tools?",
      header: "Tools",
      options: [{ label: "Bun" }, { label: "Biome" }, { label: "ESLint" }],
      multiSelect: true,
    },
  ],
};
const DECK = {
  title: "Before I build your deck",
  questions: [
    { question: "What's it about?", header: "Topic", kind: "text", placeholder: "cats" },
    { question: "How many slides?", header: "Slides", kind: "number", min: 1, max: 10 },
  ],
};
const PICK = {
  questions: [
    {
      question: "Which runtime?",
      header: "Runtime",
      options: [{ label: "Bun" }, { label: "Node" }],
    },
  ],
};

const body = (answer: Answer) => answer.body as Record<string, unknown>;

/** The hook asks, and its questions reach the chat: the Ask, still waiting, and the call's id. */
async function asked(h: AskHarness, input: unknown, count = 1) {
  const waiting = h.ask("toolu_1", input);
  let done = false;
  void waiting.then(() => (done = true));
  expect(await until(() => h.posted.length === count)).toBe(true);
  return { waiting, id: h.idOf("toolu_1"), done: () => done };
}

describe("a multi-select", () => {
  test("toggles show the picks; Done sends them as one string, in the options' order (F4)", async () => {
    const h = fresh();
    const { waiting, id } = await asked(h, TOOLS);
    await h.chat.press(`ask:${id}:0:done`, "q0");
    expect(h.toasts.at(-1)?.text).toBe(
      "Pick at least one first, or reply to the question with your own answer.",
    );
    for (const option of [2, 1, 0, 1]) await h.chat.press(`ask:${id}:0:${option}`, "q");
    const shown = h.markups.at(-1)?.reply_markup?.inline_keyboard.map((row) => row[0]?.text);
    expect(shown).toEqual(["☑ Bun", "☐ Biome", "☑ ESLint", "✅ Done", "🖥 Answer at the Mac"]);
    expect(h.markups.at(-1)).toMatchObject({ chat_id: CHAT, message_id: 101 });
    await h.chat.press(`ask:${id}:0:done`, "q5");
    expect(body(await waiting)).toMatchObject({ answers: { "Which tools?": "Bun, ESLint" } });
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("✅ Bun, ESLint");
  });
});

describe("typed answers", () => {
  test("your own answer to a choice, as a reply to its message", async () => {
    const h = fresh();
    const { waiting } = await asked(h, PICK);
    const target = h.chat.questionAt(CHAT, 101);
    expect(target).toBeDefined();
    expect(h.chat.answerText(target ?? { sessionId: "" }, "Deno, please")).toEqual({
      outcome: "answered",
    });
    expect(body(await waiting)).toMatchObject({ answers: { "Which runtime?": "Deno, please" } });
  });

  test("a text and a number question: each takes a reply; a number out of range asks again", async () => {
    const h = fresh();
    const { waiting, done } = await asked(h, DECK, 2);
    expect(h.posted.map((message) => message.header)).toEqual([
      "❓ sandbox · 5e55 asks (1 of 2)",
      "❓ sandbox · 5e55 asks (2 of 2)",
    ]);
    // A plain message goes to the session's first open question.
    expect(h.chat.answerText({ sessionId: SESSION.session_id }, "cats")).toEqual({
      outcome: "answered",
    });
    await Bun.sleep(20);
    expect(done()).toBe(false);
    const slides = h.chat.questionAt(CHAT, 102) ?? { sessionId: "" };
    expect(h.chat.answerText(slides, "eleven")).toEqual({
      outcome: "invalid",
      text: "Please send a number from 1 to 10.",
    });
    expect(h.chat.answerText(slides, "7")).toEqual({ outcome: "answered" });
    expect(body(await waiting)).toMatchObject({
      answers: { "What's it about?": "cats", "How many slides?": "7" },
    });
  });

  test("an answered question, or a call that left the chat, takes no more", async () => {
    const h = fresh();
    const { waiting } = await asked(h, DECK, 2);
    const topic = h.chat.questionAt(CHAT, 101) ?? { sessionId: "" };
    expect(h.chat.answerText(topic, "cats")).toEqual({ outcome: "answered" });
    expect(h.chat.answerText(topic, "dogs")).toEqual({ outcome: "closed" });
    h.chat.handBack();
    await waiting;
    expect(h.chat.answerText({ sessionId: SESSION.session_id }, "5")).toEqual({
      outcome: "closed",
    });
    expect(h.chat.asking()).toEqual([]);
  });
});

describe("buttons that have expired", () => {
  test('once answered, moved to the Mac, unknown or malformed: "That question has expired."', async () => {
    const h = fresh();
    const { waiting, id } = await asked(h, PICK);
    await h.chat.press(`ask:${id}:0:0`, "first");
    await waiting;
    const stale = [`ask:${id}:0:1`, `ask:${id}:mac`, "ask:00000000:0:0", "ask:nonsense"];
    for (const [at, data] of stale.entries()) await h.chat.press(data, `stale-${at}`);
    expect(h.toasts.slice(1)).toEqual(
      stale.map((_, at) => ({
        callback_query_id: `stale-${at}`,
        text: "That question has expired.",
      })),
    );
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("✅ Bun");
  });

  test("a second question's buttons still work after the first is answered", async () => {
    const h = fresh();
    const two = {
      questions: [
        PICK.questions[0],
        { question: "Which linter?", options: [{ label: "Biome" }, { label: "ESLint" }] },
      ],
    };
    const { waiting, id, done } = await asked(h, two, 2);
    await h.chat.press(`ask:${id}:0:1`, "a");
    await h.chat.press(`ask:${id}:0:0`, "b");
    expect(h.toasts.at(-1)?.text).toBe("That question has expired.");
    expect(done()).toBe(false);
    await h.chat.press(`ask:${id}:1:0`, "c");
    expect(body(await waiting)).toMatchObject({
      answers: { "Which runtime?": "Node", "Which linter?": "Biome" },
    });
  });
});
