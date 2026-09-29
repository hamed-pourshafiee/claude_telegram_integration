// A plan waiting for approval (ExitPlanMode, plan 4.2) is relayed as one question: Keep planning, or
// your own words on what to change. No hook can approve a plan (F20): whatever a hook says, Claude Code
// asks for the approval at the Mac. So the hook can only deny the call with your words, and Claude
// keeps planning; the plan itself is approved in its dialog at the Mac.

/** The tool whose call carries a finished plan (2.1.284: `plan` and `planFilePath` in its input). */
export const PLAN_TOOL = "ExitPlanMode";

/** The key of your answer to a plan; it is never shown. */
export const PLAN_QUESTION = "What should change in the plan?";
export const KEEP_PLANNING = "Keep planning";

/** What the question hook tells Claude Code for your answer to a plan: keep planning, with it. */
export function planDecision(answer: string): {
  readonly permissionDecision: "deny";
  readonly permissionDecisionReason: string;
} {
  const reason =
    answer === KEEP_PLANNING
      ? "The user wants to keep planning and hasn't said what to change yet: ask them."
      : `The user wants changes to the plan before approving it: ${answer}`;
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}
