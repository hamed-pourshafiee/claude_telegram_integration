import { asFields } from "../shared/json.ts";
import type { InlineKeyboardButton } from "../shared/telegram/types.ts";

/** How a question is answered (F4): by picking options, by typing, or with a number in a range. */
export type Kind = "choice" | "text" | "number";

export interface Option {
  readonly label: string;
  readonly description: string | undefined;
}

/** One of Claude's questions, from AskUserQuestion's input (2.1.284's schema; older ones are a part). */
export interface Question {
  readonly text: string;
  /** A short chip, such as "Library". */
  readonly header: string;
  readonly kind: Kind;
  /** A helper line under the question. */
  readonly description: string | undefined;
  readonly options: readonly Option[];
  readonly multiSelect: boolean;
  readonly placeholder: string | undefined;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly step: number | undefined;
  readonly unit: string | undefined;
}

/** A call's questions, with the heading shown above them. */
export interface AskInput {
  readonly title: string | undefined;
  readonly questions: readonly Question[];
}

/** A press of a question's button (plan 4.1). */
export type Press =
  | {
      readonly kind: "option";
      readonly askId: string;
      readonly index: number;
      readonly option: number;
    }
  | { readonly kind: "done"; readonly askId: string; readonly index: number }
  | { readonly kind: "mac"; readonly askId: string };

/** callback_data stays short: "ask:" + an 8-hex id + indexes, far under Telegram's 64 bytes. */
const BUTTON = /^ask:([0-9a-f]{8}):(?:(\d):(\d|done)|mac)$/;

/**
 * The questions of an AskUserQuestion input, or undefined when they can't be relayed: none or more than
 * four, a question without text, a choice with fewer than two options, a number without a range, or
 * two questions alike (answers are keyed by the question's text).
 */
export function parseAskInput(value: unknown): AskInput | undefined {
  const fields = asFields(value);
  const list: readonly unknown[] = Array.isArray(fields?.questions) ? fields.questions : [];
  if (list.length === 0 || list.length > 4) return undefined;
  const questions = list.map(parseQuestion);
  if (!questions.every((question) => question !== undefined)) return undefined;
  if (new Set(questions.map((question) => question.text)).size < questions.length) return undefined;
  return { title: text(fields?.title), questions };
}

function parseQuestion(value: unknown): Question | undefined {
  const fields = asFields(value);
  const question = text(fields?.question)?.trim();
  const kind = fields?.kind ?? "choice";
  if (fields === undefined || !question) return undefined;
  if (kind !== "choice" && kind !== "text" && kind !== "number") return undefined;
  const list: readonly unknown[] = Array.isArray(fields.options) ? fields.options : [];
  const options = list.map((item) => {
    const option = asFields(item);
    const label = text(option?.label);
    return label ? { label, description: text(option?.description) } : undefined;
  });
  if (!options.every((option) => option !== undefined)) return undefined;
  if (kind === "choice" && options.length < 2) return undefined;
  const [min, max] = [number(fields.min), number(fields.max)];
  if (kind === "number" && (min === undefined || max === undefined || !(min < max)))
    return undefined;
  const step = number(fields.step);
  return {
    text: question,
    header: text(fields.header) ?? "",
    kind,
    description: text(fields.description),
    options: kind === "choice" ? options : [],
    multiSelect: kind === "choice" && fields.multiSelect === true,
    placeholder: text(fields.placeholder),
    min,
    max,
    step: step !== undefined && step > 0 ? step : undefined,
    unit: text(fields.unit),
  };
}

/** A question's message as Markdown, which the formatter renders (D8): the question, its options, how. */
export function questionBody(input: AskInput, index: number): string {
  const question = input.questions[index];
  if (question === undefined) return "";
  const lines: string[] = [];
  if (index === 0 && input.title) lines.push(`**${input.title}**`, "");
  lines.push(question.header ? `**${question.header}:** ${question.text}` : question.text);
  if (question.description) lines.push(question.description);
  const options = question.options.map(({ label, description }) =>
    description ? `- **${label}**: ${description}` : `- ${label}`,
  );
  if (options.length > 0) lines.push("", ...options);
  lines.push("", howToAnswer(question));
  return lines.join("\n");
}

function howToAnswer(question: Question): string {
  if (question.kind === "text") {
    const example = question.placeholder ? ` For example: ${question.placeholder}` : "";
    return `Reply to this message with your answer.${example}`;
  }
  if (question.kind === "number") return `Reply with a number ${rangeText(question)}.`;
  if (question.multiSelect) {
    return "Tap all that apply, then Done. Or reply to this message with your own answer.";
  }
  return "Tap one, or reply to this message with your own answer.";
}

/** "from 1 to 10 slides, in steps of 1" */
function rangeText(question: Question): string {
  const unit = question.unit ? ` ${question.unit}` : "";
  const step = question.step === undefined ? "" : `, in steps of ${question.step}`;
  return `from ${question.min} to ${question.max}${unit}${step}`;
}

/**
 * A question's buttons: its options (toggles and Done for a multi-select), then "Answer at the Mac",
 * which hands the whole call back to the local dialog.
 */
export function questionButtons(
  askId: string,
  index: number,
  question: Question,
  picked: readonly number[],
): InlineKeyboardButton[][] {
  const rows = question.options.map((option, at) => {
    const mark = picked.includes(at) ? "☑" : "☐";
    const label = question.multiSelect ? `${mark} ${option.label}` : option.label;
    return [{ text: label, callback_data: `ask:${askId}:${index}:${at}` }];
  });
  if (question.multiSelect)
    rows.push([{ text: "✅ Done", callback_data: `ask:${askId}:${index}:done` }]);
  rows.push([{ text: "🖥 Answer at the Mac", callback_data: `ask:${askId}:mac` }]);
  return rows;
}

export function parsePress(data: string): Press | undefined {
  const match = BUTTON.exec(data);
  const askId = match?.[1];
  if (match === null || askId === undefined) return undefined;
  if (match[2] === undefined) return { kind: "mac", askId };
  const index = Number(match[2]);
  if (match[3] === "done") return { kind: "done", askId, index };
  return { kind: "option", askId, index, option: Number(match[3]) };
}

/** The answer a multi-select's picks make: their labels in the options' order, joined with ", " (F4). */
export function pickedAnswer(question: Question, picked: readonly number[]): string {
  return question.options
    .filter((_, at) => picked.includes(at))
    .map((option) => option.label)
    .join(", ");
}

/**
 * The answer a typed reply makes: as typed for a text or choice question (your own answer, F4); for a
 * number question, a number within its range and steps, or what to send instead.
 */
export function typedAnswer(
  question: Question,
  typed: string,
): { readonly answer: string } | { readonly problem: string } {
  const trimmed = typed.trim();
  if (question.kind !== "number") return { answer: trimmed };
  const unit = question.unit?.trim().toLowerCase();
  const bare =
    unit && trimmed.toLowerCase().endsWith(unit) ? trimmed.slice(0, -unit.length) : trimmed;
  const value = /^\s*-?\d+(?:\.\d+)?\s*$/.test(bare) ? Number(bare) : Number.NaN;
  const { min = 0, max = 0, step } = question;
  const offSteps =
    step !== undefined && Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-9;
  if (!(value >= min && value <= max) || offSteps) {
    return { problem: `Please send a number ${rangeText(question)}.` };
  }
  return { answer: String(value) };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
