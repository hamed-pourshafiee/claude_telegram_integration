import { randomUUID } from "node:crypto";
import { POLICY_TOOLS, permissionDecision } from "../shared/permission.ts";
import { PLAN_TOOL } from "../shared/plan.ts";
import { askBroker, UNTOLD } from "./asker.ts";
import type { HookContext } from "./events.ts";

/**
 * The PermissionRequest hook (phase 5, D9), which runs while the dialog is open at the Mac (F5).
 * Installed with --wait, a prompt for Bash, Edit or Write goes to the broker, which relays it while
 * you're away (flow 3) and hands back your decision: allow once, or deny with your reason. Any other
 * tool's prompt, or without --wait: the 🔐 ping only. The dialogs of AskUserQuestion and ExitPlanMode
 * are the question hook's (plans 4.1, 4.2).
 */
export async function permissionRequest(context: HookContext): Promise<void> {
  const { toolName, toolInput, cwd } = context.input;
  if (toolName === undefined || toolName === "AskUserQuestion" || toolName === PLAN_TOOL) return;
  if (!(await context.ensureBroker())) return;
  const { session, log } = context;
  if (!context.wait || toolInput === undefined || !POLICY_TOOLS.includes(toolName)) {
    await context.call("PermissionRequest", { ...session, tool: toolName, input: toolInput });
    return;
  }
  // No tool_use_id comes with a PermissionRequest: the request gets one of its own.
  const requestId = `perm_${randomUUID()}`;
  const permission = { tool: toolName, input: toolInput, cwd: cwd ?? session.project_dir };
  const body = {
    ...session,
    tool_use_id: requestId,
    input: { permission },
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
  log("hook.permission", {
    tool: toolName,
    result: result.kind === "answers" ? "answered" : result.why,
  });
  if (result.kind === "answers") {
    const decision = permissionDecision(Object.values(result.answers)[0] ?? "");
    const output = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
    context.print(JSON.stringify(output));
    return;
  }
  if (!UNTOLD.has(result.why)) return;
  // Not with the aborted signal: SIGTERM leaves a moment for this.
  await context.call("AskEnd", { ...session, tool_use_id: requestId }, 1000);
}
