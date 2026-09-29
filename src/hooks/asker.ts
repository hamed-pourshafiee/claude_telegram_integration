import { asFields, type Fields } from "../shared/json.ts";
import { pause } from "../shared/pause.ts";
import {
  CONFIRM_TRIES,
  reasonToStop,
  WAIT_CALL_MS,
  type WaiterDeps,
  watchingClaude,
} from "./waiter.ts";

/** Who asks: the session's fields, the tool call, its input, this hook's pid and its Claude's. */
export interface AskBody {
  readonly session_id: string;
  readonly project_dir: string;
  readonly entrypoint: string;
  readonly tool_use_id: string;
  /** AskUserQuestion's input: its questions, and maybe a title. */
  readonly input: Fields;
  readonly pid: number;
  readonly claude_pid: number;
}

/** Why a waiting hook stopped without the broker knowing: it hears of it now (plan 4.1). */
export const UNTOLD: ReadonlySet<string> = new Set([
  "terminated",
  "claude gone",
  "stopped before confirming",
  "confirm failed",
  "bad answer",
]);

export type AskResult =
  | { readonly kind: "answers"; readonly answers: Readonly<Record<string, string>> }
  | { readonly kind: "none"; readonly why: string };

/**
 * Asks the broker where Claude's questions go, and waits while they are in the chat (flow 3, plan
 * 4.1). The broker holds each Ask up to 25 s and answers "local" (the dialog at the Mac opens), the
 * answers, "ended", or "waiting". Answers are confirmed before they are returned, so the broker knows
 * they go in; ones that can't be confirmed are never used. With no broker at the first Ask, the dialog
 * opens at once; later, the hook starts one or tries again, as a waiting Stop hook does.
 */
export function askBroker(body: AskBody, deps: WaiterDeps): Promise<AskResult> {
  return watchingClaude(deps, (signal) => loop(body, deps, signal));
}

async function loop(body: AskBody, deps: WaiterDeps, signal: AbortSignal): Promise<AskResult> {
  let heard = false;
  for (;;) {
    const stop = reasonToStop(deps, signal);
    if (stop !== undefined) return none(stop);
    const answer = asFields(await deps.call("Ask", body, WAIT_CALL_MS, signal));
    if (answer === undefined) {
      if (signal.aborted) continue;
      if (!heard) return none("no broker");
      deps.log("hook.ask-unanswered", {});
      if (!(await deps.ensureBroker())) await pause(deps.retryMs ?? 2000, signal);
      continue;
    }
    heard = true;
    if (answer.state === "waiting") continue;
    if (answer.state === "answered") return confirm(body, answer, deps, signal);
    return none(typeof answer.state === "string" ? answer.state : "bad answer");
  }
}

/** Confirms the answers; only confirmed answers are returned for Claude. */
async function confirm(
  body: AskBody,
  answer: Fields,
  deps: WaiterDeps,
  signal: AbortSignal,
): Promise<AskResult> {
  const answers = stringsOf(answer.answers);
  if (answers === undefined) return none("bad answer");
  for (let tries = 0; tries < CONFIRM_TRIES; tries += 1) {
    if (signal.aborted) return none("stopped before confirming");
    const done = asFields(await deps.call("AskConfirm", body, 2000, signal));
    if (done?.delivered === true) return { kind: "answers", answers };
    if (done !== undefined) return none("confirm refused");
    if (!(await deps.ensureBroker())) await pause(deps.retryMs ?? 2000, signal);
  }
  return none("confirm failed");
}

/** A non-empty map of question text to answer, or undefined. */
function stringsOf(value: unknown): Record<string, string> | undefined {
  const fields = asFields(value);
  if (fields === undefined) return undefined;
  const entries = Object.entries(fields);
  if (entries.length === 0) return undefined;
  const answers: Record<string, string> = {};
  for (const [question, text] of entries) {
    if (typeof text !== "string") return undefined;
    answers[question] = text;
  }
  return answers;
}

function none(why: string): AskResult {
  return { kind: "none", why };
}
