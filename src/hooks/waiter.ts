import { asFields, type Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { pause } from "../shared/pause.ts";

/** A Wait is held up to 25 s by the broker; the call allows a little more. */
export const WAIT_CALL_MS = 30_000;
/** How many times a reply's confirmation is tried before it is given up (and never injected). */
const CONFIRM_TRIES = 15;

export interface WaiterDeps {
  /** POSTs to the broker's /hook/<name>; its answer, or undefined when none came. */
  readonly call: (
    name: string,
    body: object,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /** Starts the broker unless one answers (D3); whether one answers now. */
  readonly ensureBroker: () => Promise<boolean>;
  /** The disabled flag (D3): set, the waiter stops with no decision. */
  readonly disabled: () => boolean;
  /** Whether the Claude Code process this hook serves still runs. */
  readonly claudeAlive: () => boolean;
  /** Aborted on SIGTERM: the panel closed, or the hook's timeout came. */
  readonly signal: AbortSignal;
  readonly log: Log;
  /** Pause between tries while no broker answers; default 2 s. */
  readonly retryMs?: number;
  /** How often Claude's process is looked at; default 2 s. */
  readonly watchMs?: number;
}

/** Who waits: the session's fields, the stop's generation, this hook's pid and its Claude's. */
export interface WaitBody {
  readonly session_id: string;
  readonly project_dir: string;
  readonly entrypoint: string;
  readonly generation: number;
  readonly pid: number;
  readonly claude_pid: number;
}

export type WaitResult =
  | { readonly kind: "reply"; readonly text: string; readonly from: string | undefined }
  | { readonly kind: "none"; readonly why: string };

/**
 * Waits for a Telegram reply to this stop (flow 1, plan 3.1). It long-polls the broker's Wait, which
 * answers with a reply, "cancelled" (you typed at the Mac), "stale" (a newer stop), "ended", or
 * "waiting" after its hold. A reply is confirmed before it is returned, so the broker knows it is being
 * injected; one that can't be confirmed is never injected, and the broker reports it (D7). SIGTERM, the
 * disabled flag or Claude gone end the wait with no reply. With no broker, it starts one or tries again:
 * a restarted broker finds the waiter in its database.
 */
export async function waitForReply(body: WaitBody, deps: WaiterDeps): Promise<WaitResult> {
  const gone = new AbortController();
  const signal = AbortSignal.any([deps.signal, gone.signal]);
  const watch = setInterval(() => {
    if (!deps.claudeAlive()) gone.abort();
  }, deps.watchMs ?? 2000);
  try {
    return await loop(body, deps, signal);
  } finally {
    clearInterval(watch);
  }
}

async function loop(body: WaitBody, deps: WaiterDeps, signal: AbortSignal): Promise<WaitResult> {
  for (;;) {
    const stop = reasonToStop(deps, signal);
    if (stop !== undefined) return { kind: "none", why: stop };
    const answer = asFields(await deps.call("Wait", body, WAIT_CALL_MS, signal));
    if (answer === undefined) {
      if (signal.aborted) continue;
      deps.log("hook.wait-unanswered", { generation: body.generation });
      if (!(await deps.ensureBroker())) await pause(deps.retryMs ?? 2000, signal);
      continue;
    }
    if (answer.state === "waiting") continue;
    if (answer.state === "reply") return confirm(body, answer, deps, signal);
    return { kind: "none", why: typeof answer.state === "string" ? answer.state : "bad answer" };
  }
}

function reasonToStop(deps: WaiterDeps, signal: AbortSignal): string | undefined {
  if (deps.signal.aborted) return "terminated";
  if (signal.aborted || !deps.claudeAlive()) return "claude gone";
  if (deps.disabled()) return "disabled";
  return undefined;
}

/** Confirms the handed reply; only a confirmed reply is returned for injecting. */
async function confirm(
  body: WaitBody,
  answer: Fields,
  deps: WaiterDeps,
  signal: AbortSignal,
): Promise<WaitResult> {
  const { update_id: updateId, text, from } = answer;
  if (typeof updateId !== "number" || typeof text !== "string" || text.trim() === "") {
    return { kind: "none", why: "bad reply" };
  }
  for (let tries = 0; tries < CONFIRM_TRIES; tries += 1) {
    if (signal.aborted) return { kind: "none", why: "stopped before confirming" };
    const done = asFields(
      await deps.call("Confirm", { ...body, update_id: updateId }, 2000, signal),
    );
    if (done?.delivered === true) {
      return { kind: "reply", text, from: typeof from === "string" ? from : undefined };
    }
    if (done !== undefined) return { kind: "none", why: "confirm refused" };
    if (!(await deps.ensureBroker())) await pause(deps.retryMs ?? 2000, signal);
  }
  return { kind: "none", why: "confirm failed" };
}
