import { errorCode } from "../shared/errors.ts";
import type { HookInput } from "../shared/hook-input.ts";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import type { Pending } from "../shared/pending.ts";
import { gitBranch } from "./branch.ts";
import { type ClassifyOptions, classifyStop } from "./finish.ts";
import { postToolUse, preToolUse } from "./question.ts";
import { type WaiterDeps, waitForReply } from "./waiter.ts";

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
  /** POSTs to the broker's /hook/<name>; its answer, or undefined when none came (or `signal` aborted). */
  readonly call: (
    name: string,
    body: object,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** The hook's output for Claude Code, on stdout. */
  readonly print: (text: string) => void;
  /**
   * Installed with --wait: the Stop hook waits for a reply (asyncRewake, plan 3.1), the question hook
   * for your answers (plan 4.1).
   */
  readonly wait: boolean;
  /** Aborted on SIGTERM: the panel closed, or the hook's timeout came. */
  readonly signal: AbortSignal;
  /** Wakes Claude with `text`: the hook exits 2 with it on stderr (F2). */
  readonly rewake: (text: string) => void;
  /** The Claude Code process the hook serves (its parent), and whether it still runs. */
  readonly claudePid: number;
  readonly claudeAlive: () => boolean;
  /** The disabled flag (D3). */
  readonly disabled: () => boolean;
  /** Leaves a cancel or a waiter's end on disk for the next broker, when none answered. */
  readonly pending: (item: Pending) => void;
  /** Tests wait less for a stop's summary… */
  readonly classify?: ClassifyOptions;
  /** …and retry sooner while waiting. */
  readonly waiting?: Pick<WaiterDeps, "retryMs" | "watchMs">;
}

type Handler = (context: HookContext) => Promise<void>;

/**
 * What each hook event does (design §3, plans 2.7, 3.1 and 4.1). Nothing here decides for Claude:
 * handlers return without output, except SessionStart's note, a Stop hook that wakes Claude with a
 * reply, and a question hook that hands Claude your answers.
 */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  Stop: stop,
  Notification: notification,
  PermissionRequest: permissionRequest,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
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

/**
 * The cancel barrier (flow 2): typing at the Mac cancels the stop before it, and its waiter. With no
 * broker to tell, the cancel waits on disk; the next broker applies it before it takes replies.
 */
async function userPromptSubmit(context: HookContext): Promise<void> {
  const at = Date.now();
  const answer = await context.call("UserPromptSubmit", { ...context.session, at }, 1000);
  if (answer === undefined) {
    context.pending({ kind: "cancel", sessionId: context.session.session_id, at });
  }
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
  if (context.wait && outcome !== "continuing") await replyAfter(context, generation);
}

/** Why a wait ended without the broker knowing: it hears of it, now or from disk (plan 3.1). */
const UNTOLD: ReadonlySet<string> = new Set([
  "terminated",
  "claude gone",
  "stopped before confirming",
  "confirm failed",
  "bad reply",
  "bad answer",
]);

/** Waits for a reply to this stop and wakes Claude with it (flow 1). */
async function replyAfter(context: HookContext, generation: number): Promise<void> {
  const { session, log } = context;
  const body = { ...session, generation, pid: process.pid, claude_pid: context.claudePid };
  const result = await waitForReply(body, {
    call: (name, fields, timeoutMs, signal) => context.call(name, fields, timeoutMs, signal),
    ensureBroker: context.ensureBroker,
    disabled: context.disabled,
    claudeAlive: context.claudeAlive,
    signal: context.signal,
    log,
    ...context.waiting,
  });
  log("hook.waited", { generation, result: result.kind === "reply" ? "reply" : result.why });
  if (result.kind === "reply") {
    context.rewake(`📨 Telegram reply from ${result.from ?? "the user"}: ${result.text}`);
    return;
  }
  if (!UNTOLD.has(result.why)) return;
  // Not with the aborted signal: SIGTERM leaves a moment for this.
  if ((await context.call("End", { ...session, generation }, 1000)) !== undefined) return;
  context.pending({ kind: "end", sessionId: session.session_id, generation, at: Date.now() });
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
