import { asFields, type Fields } from "./json.ts";

/** A background task listed in a Stop input: running work such as a dev server (2.1.283 schema). */
export interface BackgroundTask {
  /** shell, subagent, monitor, workflow… */
  readonly type: string;
  readonly status: string;
  /** Up to 1,000 characters, from Claude Code. */
  readonly description: string;
  /** A shell task's command line. */
  readonly command: string | undefined;
}

/** The fields of a hook's JSON input that the bridge uses (recorded in tests/fixtures/hooks/). */
export interface HookInput {
  readonly event: string;
  readonly sessionId: string;
  readonly transcriptPath: string | undefined;
  /** Correlates a prompt with everything until the next one; also on the transcript's user entries. */
  readonly promptId: string | undefined;
  /** Set only when the hook fires inside a subagent. */
  readonly agentId: string | undefined;
  readonly lastAssistantMessage: string | undefined;
  readonly backgroundTasks: readonly BackgroundTask[];
  readonly notificationType: string | undefined;
  readonly toolName: string | undefined;
  readonly toolInput: Fields | undefined;
  /** StopFailure's error, such as model_not_found or rate_limit. */
  readonly error: string | undefined;
  /** SessionEnd's reason, such as other or prompt_input_exit. */
  readonly reason: string | undefined;
}

/** The input's fields, or undefined when it has no session_id. */
export function parseHookInput(value: unknown): HookInput | undefined {
  const fields = asFields(value);
  const sessionId = text(fields?.session_id);
  if (fields === undefined || sessionId === undefined || sessionId === "") return undefined;
  return {
    event: text(fields.hook_event_name) ?? "",
    sessionId,
    transcriptPath: text(fields.transcript_path),
    promptId: text(fields.prompt_id),
    agentId: text(fields.agent_id) || undefined,
    lastAssistantMessage: text(fields.last_assistant_message),
    backgroundTasks: parseTasks(fields.background_tasks),
    notificationType: text(fields.notification_type),
    toolName: text(fields.tool_name),
    toolInput: asFields(fields.tool_input),
    error: text(fields.error),
    reason: text(fields.reason),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The background tasks in a Stop input, or as a hook passed them on to the broker. */
export function parseTasks(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.flatMap((item) => {
    const task = asFields(item);
    if (task === undefined) return [];
    return [
      {
        type: text(task.type) ?? "task",
        status: text(task.status) ?? "",
        description: text(task.description) ?? "",
        command: text(task.command),
      },
    ];
  });
}
