import type { ContentMode } from "../shared/config.ts";
import type { BackgroundTask } from "../shared/hook-input.ts";
import { asFields, type Fields } from "../shared/json.ts";
import { type AskInput, questionBody } from "./questions.ts";

/** A notice before formatting: a header (bold, one line) and a body, which may be cut (D8). */
export interface Notice {
  readonly header: string;
  readonly body: string;
}

/** Permission dialogs are answered at the Mac until phase 5; so are questions a hook can't relay. */
const AT_THE_MAC = "Answer it at the Mac.";
const STAYS = "Its text stays on the Mac: this folder is ping-only.";
/** Background tasks listed by name; beyond this many, only counted. */
const MAX_TASKS = 5;

/** ✅ with Claude's final message (flow 1). Running background work is listed first, never cut. */
export function finishNotice(
  label: string,
  text: string,
  tasks: readonly BackgroundTask[],
  mode: ContentMode,
): Notice {
  const running = tasksText(tasks, mode);
  const reply = mode === "full" ? text.trim() || "(no text)" : STAYS;
  return { header: `✅ ${label}`, body: running ? `${running}\n\n${reply}` : reply };
}

/** 🔐 a permission dialog is open at the Mac (design §3; the dialog itself is answered there). */
export function permissionNotice(
  label: string,
  tool: string,
  input: Fields | undefined,
  mode: ContentMode,
): Notice {
  const what = mode === "full" ? describeTool(tool, input) : tool;
  return { header: `🔐 ${label} is waiting for your permission`, body: `${what}\n\n${AT_THE_MAC}` };
}

/** ❓ Claude asks a question (AskUserQuestion), with its options. */
export function questionNotice(label: string, questions: unknown, mode: ContentMode): Notice {
  const header = `❓ ${label} asks`;
  if (mode !== "full") return { header, body: `A question is waiting at the Mac. ${STAYS}` };
  const list: readonly unknown[] = Array.isArray(questions) ? questions : [];
  const parts = list.flatMap((item) => {
    const question = asFields(item);
    const text = typeof question?.question === "string" ? question.question : undefined;
    if (text === undefined) return [];
    const options: readonly unknown[] = Array.isArray(question?.options) ? question.options : [];
    const labels = options.flatMap((option) => {
      const name = asFields(option)?.label;
      return typeof name === "string" ? [`• ${name}`] : [];
    });
    return [[text, ...labels].join("\n")];
  });
  return { header, body: [...parts, AT_THE_MAC].join("\n\n") };
}

/** ❓ one of Claude's questions, to answer here (plan 4.1); only folders with full content get them. */
export function askNotice(label: string, input: AskInput, index: number): Notice {
  const count = input.questions.length;
  const of = count > 1 ? ` (${index + 1} of ${count})` : "";
  return { header: `❓ ${label} asks${of}`, body: questionBody(input, index) };
}

/**
 * ❓ a question is open in the dialog at the Mac, which no hook can answer, and you have left (flow 3).
 * Its text comes along only for folders with full content (D8).
 */
export function waitingNotice(
  label: string,
  input: AskInput | undefined,
  mode: ContentMode,
): Notice {
  const header = `❓ ${label} has a question waiting at the computer`;
  const why = "It opened while you were at the Mac, so it can only be answered there.";
  if (mode !== "full" || input === undefined) {
    return { header, body: mode === "full" ? why : `${why} ${STAYS}` };
  }
  const questions = input.questions.map((question) =>
    [question.text, ...question.options.map((option) => `- ${option.label}`)].join("\n"),
  );
  return { header, body: [...questions, why].join("\n\n") };
}

/** ⚠️ the turn ended on an API error (StopFailure). The error is a code, not Claude's text. */
export function failureNotice(label: string, error: string): Notice {
  return { header: `⚠️ ${label} stopped on an API error`, body: `Error: ${error || "unknown"}` };
}

/** What a tool is about to do, in a line: the command, the file or the URL; otherwise its input. */
export function describeTool(tool: string, input: Fields | undefined): string {
  const field = (name: string): string | undefined => {
    const value = input?.[name];
    return typeof value === "string" ? value : undefined;
  };
  const what =
    field("command") ??
    field("file_path") ??
    field("notebook_path") ??
    field("url") ??
    field("path");
  if (what !== undefined) return `${tool}: ${what}`;
  const json = JSON.stringify(input ?? {});
  return `${tool}: ${json.length > 1000 ? `${json.slice(0, 1000)}…` : json}`;
}

function tasksText(tasks: readonly BackgroundTask[], mode: ContentMode): string {
  if (tasks.length === 0) return "";
  const count = tasks.length === 1 ? "1 background task" : `${tasks.length} background tasks`;
  if (mode !== "full") return `⏳ ${count} still running.`;
  const lines = tasks.slice(0, MAX_TASKS).map((task) => {
    const what = task.command ?? task.description;
    const also = task.command !== undefined && task.description ? ` (${task.description})` : "";
    return `• ${task.type}: ${what}${also}`;
  });
  const more = tasks.length > MAX_TASKS ? [`• and ${tasks.length - MAX_TASKS} more`] : [];
  return [`⏳ ${count} still running:`, ...lines, ...more].join("\n");
}
