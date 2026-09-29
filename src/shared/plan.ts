// A plan waiting for approval (ExitPlanMode, plan 4.2) is relayed as one question with two answers.
// The hook turns the answer into Claude Code's decision: Approve allows the tool, so Claude leaves plan
// mode; anything else denies it with your words, so Claude keeps planning.

/** The tool whose call carries a finished plan (2.1.284: `plan` and `planFilePath` in its input). */
export const PLAN_TOOL = "ExitPlanMode";

export const PLAN_QUESTION = "Approve this plan?";
export const APPROVE = "Approve";
export const KEEP_PLANNING = "Keep planning";

/** What the question hook tells Claude Code for your answer to a plan. */
export function planDecision(answer: string): {
  readonly permissionDecision: "allow" | "deny";
  readonly permissionDecisionReason: string;
} {
  if (answer === APPROVE) {
    return { permissionDecision: "allow", permissionDecisionReason: "Approved from Telegram" };
  }
  const reason =
    answer === KEEP_PLANNING
      ? "The user wants to keep planning and hasn't said what to change yet: ask them."
      : `The user wants changes to the plan before approving it: ${answer}`;
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}
