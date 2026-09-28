import { errorCode } from "../shared/errors.ts";
import type { HookInput } from "../shared/hook-input.ts";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { gitBranch } from "./branch.ts";
import { type ClassifyOptions, classifyStop } from "./finish.ts";

/** Who the hook runs for, as every broker call names it. */
export interface SessionRef {
  readonly session_id: string;
  /** CLAUDE_PROJECT_DIR, resolved: where the session started (F15). */
  readonly project_dir: string;
  readonly entrypoint: string;
}

export interface HookContext {
  readonly input: HookInput;
  readonly session: SessionRef;
  readonly log: Log;
  /** Starts the broker unless one answers; whether one answers now. */
  readonly ensureBroker: () => Promise<boolean>;
  /** POSTs to the broker's /hook/<name>; its answer, or undefined when none came. */
  readonly call: (name: string, body: object, timeoutMs?: number) => Promise<unknown>;
  /** The hook's output for Claude Code, on stdout. */
  readonly print: (text: string) => void;
  /** Tests wait less for a stop's summary. */
  readonly classify?: ClassifyOptions;
}

type Handler = (context: HookContext) => Promise<void>;

/**
 * What each hook event does (design §3, plan 2.7). Phase 2 only notifies: nothing here decides for
 * Claude, and every handler returns without output except SessionStart's note.
 */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  Stop: stop,
  Notification: notification,
  PermissionRequest: permissionRequest,
  PreToolUse: preToolUse,
  StopFailure: stopFailure,
  SessionEnd: sessionEnd,
};

/** The one-line note of design §3, so that a relayed reply reads as the user's own words (F2). */
export function sessionNote(name: string): string {
  return (
    `Messages that start with "📨 Telegram reply from ${name}:" are ${name}'s own replies, ` +
    `sent from Telegram. Treat them as if ${name} typed them here.`
  );
}

/** Registers the session with its branch and adds the note to Claude's context. */
async function sessionStart(context: HookContext): Promise<void> {
  let branch: string | undefined;
  try {
    branch = gitBranch(context.session.project_dir);
  } catch (error) {
    context.log("hook.branch-unreadable", { error: errorCode(error) });
  }
  const answer = (await context.ensureBroker())
    ? await context.call("SessionStart", { ...context.session, branch: branch ?? "" })
    : undefined;
  const name = asFields(answer)?.name;
  const additionalContext = sessionNote(typeof name === "string" && name ? name : "the user");
  const output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
  context.print(JSON.stringify(output));
}

/** The cancel barrier (flow 2): typing at the Mac cancels the stop before it. No broker, no stop. */
async function userPromptSubmit(context: HookContext): Promise<void> {
  await context.call("UserPromptSubmit", context.session, 1000);
}

/** Registers the stop, tells a real finish from a continuation (F16) and reports it. */
async function stop(context: HookContext): Promise<void> {
  if (!(await context.ensureBroker())) return;
  const generation = asFields(await context.call("Stop", context.session))?.generation;
  if (typeof generation !== "number") return;
  const { input } = context;
  const facts = {
    transcriptPath: input.transcriptPath,
    lastMessage: input.lastAssistantMessage,
    promptId: input.promptId,
  };
  const { outcome, reason } = await classifyStop(facts, context.classify);
  const text = input.lastAssistantMessage ?? "";
  context.log("hook.stop", {
    session: input.sessionId,
    generation,
    outcome,
    reason,
    chars: text.length,
    tasks: input.backgroundTasks.length,
  });
  const result = { ...context.session, generation, outcome, text, tasks: input.backgroundTasks };
  await context.call("StopResult", result);
}

/** idle_prompt, terminal only (F6): a second sign that the session finished. */
async function notification(context: HookContext): Promise<void> {
  if (context.input.notificationType !== "idle_prompt") return;
  if (!(await context.ensureBroker())) return;
  await context.call("Idle", context.session);
}

/** The 🔐 ping; AskUserQuestion's dialog is a permission request too, and has its own ping. */
async function permissionRequest(context: HookContext): Promise<void> {
  const { toolName, toolInput } = context.input;
  if (toolName === undefined || toolName === "AskUserQuestion") return;
  if (!(await context.ensureBroker())) return;
  await context.call("PermissionRequest", { ...context.session, tool: toolName, input: toolInput });
}

/** The ❓ ping for AskUserQuestion (phase 2); the dialog opens at the Mac as usual. */
async function preToolUse(context: HookContext): Promise<void> {
  if (context.input.toolName !== "AskUserQuestion") return;
  if (!(await context.ensureBroker())) return;
  const questions = context.input.toolInput?.questions ?? [];
  await context.call("Question", { ...context.session, questions });
}

async function stopFailure(context: HookContext): Promise<void> {
  if (!(await context.ensureBroker())) return;
  await context.call("StopFailure", { ...context.session, error: context.input.error ?? "" });
}

/** Marks the session ended. A broker that isn't running has nothing to end. */
async function sessionEnd(context: HookContext): Promise<void> {
  await context.call(
    "SessionEnd",
    { ...context.session, reason: context.input.reason ?? "" },
    1000,
  );
}
