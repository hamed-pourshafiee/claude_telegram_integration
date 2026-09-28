// Spike S2 (implementation-plan 1.3): can a PreToolUse hook answer AskUserQuestion, so that no local
// dialog appears? Throwaway. Sessions outside <repo>/sandbox/ get no decision, before any file access.
// Inside, .state/spikes/s2.json picks the answer: {"mode":"first"} takes each question's first option,
// {"mode":"text","text":"…"} answers every question with that free text, {"mode":"multi"} takes the
// first two options of multi-select questions. No file, or {"mode":"off"}: no decision (normal dialog).
// Events go to .state/spikes/s2.log: counts and kinds, never the question text.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendLog,
  asObject,
  isInside,
  type JsonObject,
  readHookInput,
  SANDBOX_DIR,
  SPIKE_DIR,
} from "./lib.ts";

const LOG = "s2.log";
const CONTROL = join(SPIKE_DIR, "s2.json");

export type Mode = { mode: "off" | "first" | "multi" } | { mode: "text"; text: string };
export type Answers = Record<string, string | string[]>;

/** The tool's `answers` map (question text → label, labels or free text), or undefined to stay out. */
export function answersFor(questions: unknown, mode: Mode): Answers | undefined {
  if (mode.mode === "off" || !Array.isArray(questions) || questions.length === 0) return undefined;
  const answers: Answers = {};
  for (const item of questions) {
    const question = asObject(item);
    if (!question || typeof question.question !== "string") return undefined;
    if (mode.mode === "text") {
      answers[question.question] = mode.text;
      continue;
    }
    const labels = optionLabels(question);
    if (labels.length === 0) return undefined; // a text or number question: leave it to the dialog
    const pickTwo = mode.mode === "multi" && question.multiSelect === true;
    answers[question.question] = pickTwo ? labels.slice(0, 2) : (labels[0] ?? "");
  }
  return answers;
}

function optionLabels(question: JsonObject): string[] {
  if ((question.kind ?? "choice") !== "choice" || !Array.isArray(question.options)) return [];
  return question.options.flatMap((option) => {
    const label = asObject(option)?.label;
    return typeof label === "string" ? [label] : [];
  });
}

function readMode(): Mode {
  if (!existsSync(CONTROL)) return { mode: "off" };
  const raw = asObject(JSON.parse(readFileSync(CONTROL, "utf8")));
  if (raw?.mode === "text" && typeof raw.text === "string") return { mode: "text", text: raw.text };
  if (raw?.mode === "first" || raw?.mode === "multi") return { mode: raw.mode };
  return { mode: "off" };
}

function summarize(questions: unknown): JsonObject {
  const list = Array.isArray(questions) ? questions.map((q) => asObject(q) ?? {}) : [];
  return {
    questions: list.length,
    kinds: list.map((q) => q.kind ?? "choice"),
    multiSelect: list.map((q) => q.multiSelect === true),
    options: list.map((q) => (Array.isArray(q.options) ? q.options.length : 0)),
  };
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!isInside(cwd, SANDBOX_DIR) || input.tool_name !== "AskUserQuestion") return;

  const toolInput = asObject(input.tool_input);
  const mode = readMode();
  const answers = toolInput ? answersFor(toolInput.questions, mode) : undefined;
  appendLog(LOG, {
    session: typeof input.session_id === "string" ? input.session_id : "unknown",
    event: answers ? "answer" : "skip",
    mode: mode.mode,
    inputKeys: Object.keys(input).sort(),
    toolInputKeys: Object.keys(toolInput ?? {}).sort(),
    ...summarize(toolInput?.questions),
    answerShapes: Object.values(answers ?? {}).map((a) =>
      Array.isArray(a) ? `list:${a.length}` : "text",
    ),
  });
  if (!toolInput || !answers) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, answers },
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    logFailure("unhandledRejection", reason);
    process.exit(0);
  });
  main().catch((error: unknown) => {
    logFailure("main", error);
    process.exitCode = 0; // fail safe: no output, so the normal dialog opens (design D5)
  });
}

function logFailure(where: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    appendLog(LOG, { event: "error", where, message, pid: process.pid });
  } catch (logError) {
    process.stderr.write(`s2 spike: ${where}: ${message} (log failed: ${String(logError)})\n`);
  }
}
