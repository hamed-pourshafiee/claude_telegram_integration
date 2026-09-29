import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "../shared/errors.ts";
import type { Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { HOME_DIR } from "../shared/paths.ts";
import { PLAN_TOOL, planDecision } from "../shared/plan.ts";
import { isInside } from "../shared/scope.ts";
import { askBroker, UNTOLD } from "./asker.ts";
import type { HookContext } from "./events.ts";

const QUESTION_TOOL = "AskUserQuestion";
/** A plan file larger than this is left to the dialog. */
const MAX_PLAN_BYTES = 1_000_000;

/**
 * The question hook (PreToolUse on AskUserQuestion and ExitPlanMode, flow 3). Installed with --wait,
 * it asks the broker where Claude's questions, or its plan, go: to the dialog at the Mac, which then
 * opens as usual, or to the chat, where it waits for your answers and hands them to Claude (F4), so no
 * dialog opens. A plan in the chat can only be sent back for more planning; it is approved in its dialog
 * at the Mac (F20). Without --wait, phase 2's ❓ ping for questions only.
 */
export async function preToolUse(context: HookContext): Promise<void> {
  const { toolName, toolInput, toolUseId } = context.input;
  if (toolName !== QUESTION_TOOL && toolName !== PLAN_TOOL) return;
  if (!(await context.ensureBroker())) return;
  if (!context.wait || toolInput === undefined || toolUseId === undefined) {
    const questions = toolInput?.questions ?? [];
    if (toolName === QUESTION_TOOL)
      await context.call("Question", { ...context.session, questions });
    return;
  }
  const claudeDir = context.claudeDir ?? join(HOME_DIR, ".claude");
  const input = toolName === PLAN_TOOL ? planInput(toolInput, claudeDir, context.log) : toolInput;
  if (input === undefined) return;
  const { session, log } = context;
  const body = {
    ...session,
    tool_use_id: toolUseId,
    input,
    pid: process.pid,
    claude_pid: context.claudePid,
  };
  const result = await askBroker(body, {
    call: (name, fields, timeoutMs, signal) => context.call(name, fields, timeoutMs, signal),
    ensureBroker: context.ensureBroker,
    disabled: context.disabled,
    claudeAlive: context.claudeAlive,
    signal: context.signal,
    log,
    ...context.waiting,
  });
  log("hook.asked", {
    tool: toolName,
    result: result.kind === "answers" ? "answered" : result.why,
  });
  if (result.kind === "answers") {
    context.print(JSON.stringify(outputFor(toolName, toolInput, result.answers)));
    return;
  }
  if (!UNTOLD.has(result.why)) return;
  // Not with the aborted signal: SIGTERM leaves a moment for this.
  await context.call("AskEnd", { ...session, tool_use_id: toolUseId }, 1000);
}

/** PostToolUse on AskUserQuestion or ExitPlanMode: Claude has the answers, so the call is closed. */
export async function postToolUse(context: HookContext): Promise<void> {
  const { toolName, toolUseId } = context.input;
  if (toolName !== QUESTION_TOOL && toolName !== PLAN_TOOL) return;
  if (toolUseId === undefined) return;
  await context.call("Asked", { ...context.session, tool_use_id: toolUseId }, 1000);
}

/**
 * The decision for Claude Code: a question's answers go in as updatedInput (F4); a plan is denied with
 * your words, so Claude keeps planning (plan 4.2, F20).
 */
function outputFor(tool: string, toolInput: Fields, answers: Readonly<Record<string, string>>) {
  const decision =
    tool === PLAN_TOOL
      ? planDecision(Object.values(answers)[0] ?? "")
      : {
          permissionDecision: "allow",
          permissionDecisionReason: "Answered from Telegram",
          updatedInput: { ...toolInput, answers },
        };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } };
}

/**
 * What the broker gets of an ExitPlanMode call: its plan, which 2.1.284 puts in the input, or else
 * reads from its plan file (a .md file under `claudeDir`, ~/.claude). No plan: the dialog opens.
 */
function planInput(toolInput: Fields, claudeDir: string, log: Log): Fields | undefined {
  // Which way the plan came, and the input's field names (never its text): F4 and F19 in practice.
  const keys = Object.keys(toolInput).sort().join(",");
  const { plan, planFilePath: file } = toolInput;
  if (typeof plan === "string" && plan.trim() !== "") {
    log("hook.plan", { from: "input", keys, chars: plan.length });
    return { plan };
  }
  const text = planFile(file, claudeDir, log);
  log("hook.plan", { from: text === undefined ? "none" : "file", keys });
  return text === undefined ? undefined : { plan: text };
}

function planFile(file: unknown, claudeDir: string, log: Log): string | undefined {
  if (typeof file !== "string" || !file.endsWith(".md") || !isInside(file, claudeDir)) {
    return undefined;
  }
  try {
    if (statSync(file).size > MAX_PLAN_BYTES) return undefined;
    const text = readFileSync(file, "utf8");
    return text.trim() === "" ? undefined : text;
  } catch (error) {
    log("hook.plan-unreadable", { error: errorCode(error) });
    return undefined;
  }
}
