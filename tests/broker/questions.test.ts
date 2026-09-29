import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AskInput,
  parseAskInput,
  parsePress,
  pickedAnswer,
  questionBody,
  questionButtons,
  typedAnswer,
} from "../../src/broker/questions.ts";

// Plan 4.1: Claude's questions as AskUserQuestion gives them (F4), as the chat shows them, and the
// answers made from your taps and replies.
const recorded = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/hooks/claude-vscode/PreToolUse-AskUserQuestion.json"),
    "utf8",
  ),
);

function parsed(value: unknown): AskInput {
  const input = parseAskInput(value);
  if (input === undefined) throw new Error("not parsed");
  return input;
}

const choice = (multiSelect = false) => ({
  question: "Which tools?",
  header: "Tools",
  options: [{ label: "Bun", description: "Fast." }, { label: "Biome" }, { label: "ESLint" }],
  multiSelect,
});
const number = { question: "How many slides?", header: "Slides", kind: "number", min: 1, max: 10 };

describe("reading the questions", () => {
  test("a recorded call: a choice with its options (2.1.283)", () => {
    const input = parsed(recorded.input.tool_input);
    expect(input.questions).toEqual([
      expect.objectContaining({
        text: "Which color do you prefer?",
        header: "Color",
        kind: "choice",
        multiSelect: false,
        options: [
          { label: "Red", description: "The color red." },
          { label: "Green", description: "The color green." },
          { label: "Blue", description: "The color blue." },
        ],
      }),
    ]);
  });

  test("2.1.284's kinds: text with a placeholder, number with a range, steps and a unit", () => {
    const input = parsed({
      title: "Before I build your deck",
      questions: [
        { question: "What's it about?", header: "Topic", kind: "text", placeholder: "cats" },
        { ...number, step: 1, unit: "slides" },
      ],
    });
    expect(input.title).toBe("Before I build your deck");
    expect(input.questions[0]).toMatchObject({ kind: "text", placeholder: "cats", options: [] });
    expect(input.questions[1]).toMatchObject({ kind: "number", min: 1, max: 10, unit: "slides" });
  });

  test("what can't be relayed is left to the dialog at the Mac", () => {
    const unreadable = [
      undefined,
      { questions: [] },
      {
        questions: [choice(), choice(), choice(), choice(), choice()].map((q, i) => ({
          ...q,
          question: `${i}?`,
        })),
      },
      { questions: [{ ...choice(), options: [{ label: "Only one" }] }] },
      { questions: [{ question: "How many?", kind: "number", min: 5, max: 5 }] },
      { questions: [{ question: "?", kind: "slider" }] },
      { questions: [choice(), choice()] }, // the same text twice: answers are keyed by it
    ];
    for (const value of unreadable) expect(parseAskInput(value)).toBeUndefined();
  });
});

describe("the chat's message and buttons", () => {
  test("a choice: the question, its options, how to answer; a button each, and one for the Mac", () => {
    const input = parsed({ questions: [choice()] });
    const body = questionBody(input, 0);
    expect(body).toContain("**Tools:** Which tools?");
    expect(body).toContain("- **Bun**: Fast.\n- Biome\n- ESLint");
    expect(body).toContain("Tap one, or reply to this message with your own answer.");
    const rows = questionButtons("0a1b2c3d", 0, input.questions[0] ?? (choice() as never), []);
    expect(rows.map((row) => row.map((button) => button.text))).toEqual([
      ["Bun"],
      ["Biome"],
      ["ESLint"],
      ["🖥 Answer at the Mac"],
    ]);
    expect(rows.flat().map((button) => button.callback_data)).toEqual([
      "ask:0a1b2c3d:0:0",
      "ask:0a1b2c3d:0:1",
      "ask:0a1b2c3d:0:2",
      "ask:0a1b2c3d:mac",
    ]);
  });

  test("a multi-select: toggles that show the picks, and Done", () => {
    const [question] = parsed({ questions: [choice(true)] }).questions;
    if (question === undefined) throw new Error("no question");
    const rows = questionButtons("0a1b2c3d", 2, question, [0, 2]);
    expect(rows.map((row) => row[0]?.text)).toEqual([
      "☑ Bun",
      "☐ Biome",
      "☑ ESLint",
      "✅ Done",
      "🖥 Answer at the Mac",
    ]);
    expect(rows[3]?.[0]?.callback_data).toBe("ask:0a1b2c3d:2:done");
  });

  test("a text or number question says what to reply; the title heads the first one only", () => {
    const input = parsed({
      title: "Deck",
      questions: [
        { question: "Topic?", kind: "text", placeholder: "cats" },
        { ...number, step: 2, unit: "slides" },
      ],
    });
    expect(questionBody(input, 0)).toStartWith("**Deck**\n\nTopic?");
    expect(questionBody(input, 0)).toContain(
      "Reply to this message with your answer. For example: cats",
    );
    expect(questionBody(input, 1)).not.toContain("Deck");
    expect(questionBody(input, 1)).toContain(
      "Reply with a number from 1 to 10 slides, in steps of 2.",
    );
  });
});

describe("the buttons' data", () => {
  test("every button's data fits Telegram's 64 bytes, and reads back", () => {
    const [question] = parsed({
      questions: [
        {
          ...choice(true),
          options: Array.from({ length: 4 }, (_, i) => ({ label: `Option ${i}` })),
        },
      ],
    }).questions;
    if (question === undefined) throw new Error("no question");
    for (const button of questionButtons("ffffffff", 3, question, [])) {
      const data = button[0]?.callback_data ?? "";
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parsePress(data)).toBeDefined();
    }
    expect(parsePress("ask:ffffffff:3:1")).toEqual({
      kind: "option",
      askId: "ffffffff",
      index: 3,
      option: 1,
    });
    expect(parsePress("ask:ffffffff:3:done")).toEqual({
      kind: "done",
      askId: "ffffffff",
      index: 3,
    });
    expect(parsePress("ask:ffffffff:mac")).toEqual({ kind: "mac", askId: "ffffffff" });
    for (const bad of ["ask:xyz:0:0", "ask:ffffffff:0", "full:ffffffff", "ask:ffffffff:12:0"]) {
      expect(parsePress(bad)).toBeUndefined();
    }
  });
});

describe("answers", () => {
  test("a multi-select's picks: one string, in the options' order, joined with \", \" (F4)", () => {
    const [question] = parsed({ questions: [choice(true)] }).questions;
    if (question === undefined) throw new Error("no question");
    expect(pickedAnswer(question, [2, 0])).toBe("Bun, ESLint");
  });

  test("typed: as written for a choice (your own answer) or a text question", () => {
    const [pick, text] = parsed({
      questions: [choice(), { question: "Why?", kind: "text" }],
    }).questions;
    if (pick === undefined || text === undefined) throw new Error("no question");
    expect(typedAnswer(pick, "  Deno, please  ")).toEqual({ answer: "Deno, please" });
    expect(typedAnswer(text, "Because it's fast")).toEqual({ answer: "Because it's fast" });
  });

  test("a number: within its range and steps, with or without its unit; otherwise, what to send", () => {
    const [plain, stepped] = parsed({
      questions: [number, { ...number, question: "Width?", min: 0, max: 100, step: 5, unit: "px" }],
    }).questions;
    if (plain === undefined || stepped === undefined) throw new Error("no question");
    expect(typedAnswer(plain, "7")).toEqual({ answer: "7" });
    expect(typedAnswer(plain, " 2.5 ")).toEqual({ answer: "2.5" });
    expect(typedAnswer(stepped, "35px")).toEqual({ answer: "35" });
    expect(typedAnswer(stepped, "35 PX")).toEqual({ answer: "35" });
    for (const [question, typed] of [
      [plain, "11"],
      [plain, "0"],
      [plain, "seven"],
      [plain, "7 slides please"],
      [stepped, "33"],
      [plain, ""],
    ] as const) {
      expect(typedAnswer(question, typed)).toEqual({
        problem: expect.stringMatching(/^Please send a number from/),
      });
    }
  });
});
