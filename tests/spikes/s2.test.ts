import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SPIKE_DIR } from "../../scripts/spikes/lib.ts";
import { answersFor } from "../../scripts/spikes/s2-answer-question.ts";

const color = {
  question: "Which color?",
  header: "Color",
  options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }],
  multiSelect: false,
};
const tools = {
  question: "Which tools?",
  header: "Tools",
  options: [{ label: "Bun" }, { label: "Biome" }, { label: "tsc" }],
  multiSelect: true,
};
const count = { question: "How many?", header: "Count", kind: "number", min: 1, max: 5 };

describe("answersFor", () => {
  test("first: each question's first option", () => {
    expect(answersFor([color, tools], { mode: "first" })).toEqual({
      "Which color?": "Red",
      "Which tools?": "Bun",
    });
  });

  test("multi: the first two options of a multi-select question, as a list", () => {
    expect(answersFor([color, tools], { mode: "multi" })).toEqual({
      "Which color?": "Red",
      "Which tools?": ["Bun", "Biome"],
    });
  });

  test("text: the same free text for every question", () => {
    expect(answersFor([color, count], { mode: "text", text: "Purple" })).toEqual({
      "Which color?": "Purple",
      "How many?": "Purple",
    });
  });

  test("stays out when off, malformed, or a choice answer can't be picked", () => {
    expect(answersFor([color], { mode: "off" })).toBeUndefined();
    expect(answersFor("not a list", { mode: "first" })).toBeUndefined();
    expect(answersFor([], { mode: "first" })).toBeUndefined();
    expect(answersFor([{ header: "no question text" }], { mode: "first" })).toBeUndefined();
    expect(answersFor([color, count], { mode: "first" })).toBeUndefined();
  });
});

test("s2 hook gives no decision outside sandbox/ and writes nothing", async () => {
  const log = join(SPIKE_DIR, "s2.log");
  const size = existsSync(log) ? statSync(log).size : -1;
  const input = {
    session_id: "test",
    cwd: REPO_ROOT,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [color] },
  };
  const hook = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${REPO_ROOT}/bunfig.toml`,
      join(REPO_ROOT, "scripts/spikes/s2-answer-question.ts"),
    ],
    { cwd: REPO_ROOT, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    hook.exited,
    new Response(hook.stdout).text(),
    new Response(hook.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(existsSync(log) ? statSync(log).size : -1).toBe(size);
});
