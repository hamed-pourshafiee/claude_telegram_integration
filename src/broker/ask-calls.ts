import type { Config } from "../shared/config.ts";
import { asFields, type Fields } from "../shared/json.ts";
import { contentModeFor } from "../shared/scope.ts";
import { operationFile } from "./operation.ts";
import type { Pairing } from "./pairing.ts";
import type { Presence } from "./presence.ts";
import type { AskInput } from "./questions.ts";
import { redact } from "./redact.ts";
import type { Session } from "./sessions.ts";

// A question hook's calls to the broker, and where each goes (flow 3; plans 4.1, 4.2 and phase 5).

/** Where a new call goes: to the chat, or to the dialog at the Mac, and why. */
export type Where = { readonly chat: number } | { readonly local: string };

/** A hook's call, as it names the AskUserQuestion call it waits for. */
export interface Call {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly pid: number;
  readonly claudePid: number;
  readonly input: Fields | undefined;
}

/**
 * Flow 3 for a new call: to the chat while you're in between or away, and to the dialog at the Mac
 * while you're active, or when the bridge is muted, not paired, or the folder is ping-only (D8).
 */
export function askWhere(deps: {
  readonly pairing: Pick<Pairing, "pairedUser">;
  readonly presence: Pick<Presence, "snapshot">;
  readonly config: Config;
}): (session: Session) => Where {
  return (session) => {
    const user = deps.pairing.pairedUser();
    if (user === undefined) return { local: "not paired" };
    if (contentModeFor(deps.config, session.projectDir) !== "full") return { local: "ping-only" };
    // A session started from the chat reports there wherever you are, and /off doesn't mute it (D11).
    if (session.fromChat) return { chat: user.id };
    const { mode, state } = deps.presence.snapshot();
    if (mode === "off") return { local: "muted" };
    if (state === "active") return { local: "at the Mac" };
    return { chat: user.id };
  };
}

/**
 * Where a new call goes. One that can't be read goes to the dialog; so does a permission prompt that
 * holds what looks like a secret, as it couldn't be shown whole (D9). The rest go where `where` says.
 */
export function whereOf(
  input: AskInput | undefined,
  session: Session,
  where: (session: Session) => Where,
): Where {
  if (input === undefined) return { local: "unreadable" };
  const permission = input.permission;
  if (permission !== undefined && redact(operationFile(permission)).count > 0) {
    return { local: "secret" };
  }
  return where(session);
}

export function callOf(fields: Fields): Call | undefined {
  const { session_id: sessionId, tool_use_id: toolUseId, pid, claude_pid: claudePid } = fields;
  if (typeof sessionId !== "string" || sessionId === "" || typeof toolUseId !== "string") {
    return undefined;
  }
  if (toolUseId === "" || typeof pid !== "number" || typeof claudePid !== "number")
    return undefined;
  return { sessionId, toolUseId, pid, claudePid, input: asFields(fields.input) };
}

/**
 * What is kept of a call's input: a plan waiting for approval (plan 4.2), a permission prompt's
 * operation (phase 5), or the questions.
 */
export function keptOf(input: Fields | undefined): object {
  const plan = input?.plan;
  if (typeof plan === "string") return { plan };
  if (input?.permission !== undefined) return { permission: input.permission };
  return { title: input?.title, questions: input?.questions };
}

/** Eight hex digits: short enough for the buttons' callback_data. */
export function newAskId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
