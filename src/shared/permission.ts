// A permission prompt relayed to the chat (phase 5, D9) is one question: Allow once, or Deny; a reply
// denies it with your reason. The PermissionRequest hook turns the answer into Claude Code's decision.

/** The tools whose prompts may be approved from Telegram (D9): never MCP tools or WebFetch. */
export const POLICY_TOOLS: readonly string[] = ["Bash", "Edit", "Write"];

/** The key of your answer to a permission prompt; it is never shown. */
export const PERMISSION_QUESTION = "Allow this?";
export const ALLOW_ONCE = "Allow once";
export const DENY = "Deny";

/** A PermissionRequest hook's decision (F5): allow once, or deny with a message for Claude. */
export type PermissionDecision =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message: string };

/** What the hook tells Claude Code for your answer: never "always allow" (D9). */
export function permissionDecision(answer: string): PermissionDecision {
  if (answer === ALLOW_ONCE) return { behavior: "allow" };
  const message =
    answer === DENY
      ? "The user denied this from Telegram."
      : `The user denied this from Telegram: ${answer}`;
  return { behavior: "deny", message };
}
