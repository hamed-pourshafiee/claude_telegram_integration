import { askBroker } from "./asker.ts";
import type { HookContext } from "./events.ts";

/** Why a question hook stopped without the broker knowing: it hears of it now (plan 4.1). */
const UNTOLD: ReadonlySet<string> = new Set([
  "terminated",
  "claude gone",
  "stopped before confirming",
  "confirm failed",
  "bad answer",
]);

/**
 * The question hook (PreToolUse on AskUserQuestion, flow 3). Installed with --wait, it asks the broker
 * where Claude's questions go: to the dialog at the Mac, which then opens as usual, or to the chat,
 * where it waits for your answers and hands them to Claude (F4), so no dialog opens. Without --wait,
 * phase 2's ❓ ping only.
 */
export async function preToolUse(context: HookContext): Promise<void> {
  const { toolName, toolInput, toolUseId } = context.input;
  if (toolName !== "AskUserQuestion") return;
  if (!(await context.ensureBroker())) return;
  if (!context.wait || toolInput === undefined || toolUseId === undefined) {
    await context.call("Question", { ...context.session, questions: toolInput?.questions ?? [] });
    return;
  }
  const { session, log } = context;
  const body = {
    ...session,
    tool_use_id: toolUseId,
    input: toolInput,
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
  log("hook.asked", { result: result.kind === "answers" ? "answered" : result.why });
  if (result.kind === "answers") {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Answered from Telegram",
        updatedInput: { ...toolInput, answers: result.answers },
      },
    };
    context.print(JSON.stringify(output));
    return;
  }
  if (!UNTOLD.has(result.why)) return;
  // Not with the aborted signal: SIGTERM leaves a moment for this.
  await context.call("AskEnd", { ...session, tool_use_id: toolUseId }, 1000);
}

/** PostToolUse on AskUserQuestion: Claude has the answers, so the question is closed. */
export async function postToolUse(context: HookContext): Promise<void> {
  const { toolName, toolUseId } = context.input;
  if (toolName !== "AskUserQuestion" || toolUseId === undefined) return;
  await context.call("Asked", { ...context.session, tool_use_id: toolUseId }, 1000);
}
