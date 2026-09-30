import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS, type HookContext, sessionNote } from "../../src/hooks/events.ts";
import { parseHookInput } from "../../src/shared/hook-input.ts";
import { type Log, type LogFields, noLog } from "../../src/shared/log.ts";
import type { Pending } from "../../src/shared/pending.ts";
import { Transcript } from "../helpers/transcript.ts";

// Plans 2.7 and 3.1: what each hook asks of the broker. The broker is a stand-in that records the calls.
const dir = mkdtempSync(join(tmpdir(), "tg-events-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = {
  session_id: "b1e81638",
  project_dir: dir,
  entrypoint: "claude-vscode",
  claude_pid: 1234,
};

type Respond = (name: string, body: Record<string, unknown>) => unknown;
let calls: { name: string; body: Record<string, unknown>; timeoutMs: number | undefined }[];
let printed: string[];
let started: number;
let brokerUp: boolean;
let respond: Respond;
let pending: Pending[];
let rewoken: string[];
beforeEach(() => {
  [calls, printed, started, brokerUp, pending, rewoken] = [[], [], 0, true, [], []];
  respond = () => ({});
});

interface RunOptions {
  readonly wait?: boolean;
  readonly signal?: AbortSignal;
  readonly log?: Log;
  readonly fromChat?: boolean;
}

async function run(event: string, fields: Record<string, unknown> = {}, options: RunOptions = {}) {
  const input = parseHookInput({
    session_id: session.session_id,
    hook_event_name: event,
    ...fields,
  });
  if (input === undefined) throw new Error("bad test input");
  const context: HookContext = {
    input,
    session,
    log: options.log ?? noLog,
    ensureBroker: () => {
      started += 1;
      return Promise.resolve(brokerUp);
    },
    call: (name, body, timeoutMs) => {
      calls.push({ name, body: { ...body }, timeoutMs });
      return Promise.resolve(respond(name, { ...body }));
    },
    print: (text) => printed.push(text),
    wait: options.wait ?? false,
    signal: options.signal ?? new AbortController().signal,
    rewake: (text) => rewoken.push(text),
    claudePid: 1234,
    claudeAlive: () => true,
    disabled: () => false,
    pending: (item) => pending.push(item),
    classify: { timeoutMs: 500, pollMs: 20 },
    waiting: { retryMs: 5, watchMs: 20 },
    fromChat: options.fromChat ?? false,
  };
  await HANDLERS[event]?.(context);
}

/** A finished stop: its transcript and the Stop input's fields. */
function finishedStop(name: string) {
  const transcript = join(dir, `${name}.jsonl`);
  writeFileSync(transcript, new Transcript().prompt("p1").assistant("Done.").summary().jsonl());
  return { transcript_path: transcript, prompt_id: "p1", last_assistant_message: "Done." };
}

describe("SessionStart", () => {
  test("registers the session and adds the note, with the paired user's name", async () => {
    respond = () => ({ name: "Hamed" });
    await run("SessionStart");
    expect(calls).toMatchObject([{ name: "SessionStart", body: { ...session, branch: "" } }]);
    expect(JSON.parse(printed[0] ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: sessionNote("Hamed"),
      },
    });
    expect(sessionNote("Hamed")).toStartWith(
      'Messages that start with "📨 Telegram reply from Hamed:"',
    );
  });

  test("no broker: still the note, naming no one", async () => {
    brokerUp = false;
    await run("SessionStart");
    expect(calls).toEqual([]);
    expect(printed[0]).toContain("📨 Telegram reply from the user:");
  });
});

describe("Stop", () => {
  test("registers, classifies from the transcript, reports the finish with its tasks", async () => {
    const task = {
      type: "shell",
      status: "running",
      description: "Dev server",
      command: "npm run dev",
    };
    respond = () => ({ generation: 7 });
    await run("Stop", { ...finishedStop("finish"), background_tasks: [task] });
    expect(calls.map((c) => c.name)).toEqual(["Stop", "StopResult"]);
    const result = { ...session, generation: 7, outcome: "finish", text: "Done.", tasks: [task] };
    expect(calls[1]?.body).toEqual(result);
  });

  test("logs how the stop read, with the Claude Code version of its summary (plan 6.1)", async () => {
    const transcript = join(dir, "versioned.jsonl");
    const t = new Transcript().prompt("p1").assistant("Done.").summary({ version: "2.1.284" });
    writeFileSync(transcript, t.jsonl());
    respond = () => ({ generation: 8 });
    const stops: LogFields[] = [];
    const log: Log = (event, fields) => {
      if (event === "hook.stop") stops.push(fields);
    };
    const fields = {
      transcript_path: transcript,
      prompt_id: "p1",
      last_assistant_message: "Done.",
    };
    await run("Stop", fields, { log });
    expect(stops).toEqual([
      expect.objectContaining({
        outcome: "finish",
        reason: "no continuation entry",
        version: "2.1.284",
      }),
    ]);
  });

  test("no broker: no classification, no calls", async () => {
    brokerUp = false;
    await run("Stop", { last_assistant_message: "Done." });
    expect(calls).toEqual([]);
  });
});

describe("Stop with --wait (plan 3.1)", () => {
  test("waits after a finish; a confirmed reply wakes Claude with your words", async () => {
    respond = (name) =>
      ({
        Stop: { generation: 7 },
        Wait: { state: "reply", update_id: 900, text: "now say bye", from: "Hamed" },
        Confirm: { delivered: true },
      })[name] ?? {};
    await run("Stop", finishedStop("reply"), { wait: true });
    expect(calls.map((c) => c.name)).toEqual(["Stop", "StopResult", "Wait", "Confirm"]);
    expect(calls[2]?.body).toMatchObject({ ...session, generation: 7, claude_pid: 1234 });
    expect(rewoken).toEqual(["📨 Telegram reply from Hamed: now say bye"]);
  });

  test("SIGTERM: the wait ends and says so; with no broker, the end waits on disk", async () => {
    const terminated = new AbortController();
    respond = (name) => {
      if (name === "Wait") terminated.abort();
      return name === "Stop" ? { generation: 3 } : name === "End" ? undefined : {};
    };
    await run("Stop", finishedStop("sigterm"), { wait: true, signal: terminated.signal });
    expect(calls.map((c) => c.name)).toEqual(["Stop", "StopResult", "Wait", "End"]);
    expect(pending).toMatchObject([{ kind: "end", sessionId: session.session_id, generation: 3 }]);
    expect(rewoken).toEqual([]);
  });

  test("a continuing stop never waits; without --wait (phase 2's install) no stop does", async () => {
    const transcript = join(dir, "continuing.jsonl");
    const blocked = new Transcript().prompt("p1").assistant("Done.").blocked("p1").summary();
    writeFileSync(transcript, blocked.jsonl());
    respond = (name) => (name === "Stop" ? { generation: 4 } : {});
    const fields = {
      transcript_path: transcript,
      prompt_id: "p1",
      last_assistant_message: "Done.",
    };
    await run("Stop", fields, { wait: true });
    await run("Stop", finishedStop("unwaited"));
    expect(calls.map((c) => c.name)).toEqual(["Stop", "StopResult", "Stop", "StopResult"]);
  });
});

describe("the others", () => {
  test("UserPromptSubmit: the cancel with when you typed, quickly, without starting a broker", async () => {
    const before = Date.now();
    await run("UserPromptSubmit", { prompt: "go on" });
    expect(calls).toMatchObject([{ name: "UserPromptSubmit", body: session, timeoutMs: 1000 }]);
    expect(Number(calls[0]?.body.at)).toBeGreaterThanOrEqual(before);
    expect(started).toBe(0);
    expect(pending).toEqual([]);
  });

  test("UserPromptSubmit with no broker: the cancel waits on disk for the next one", async () => {
    respond = () => undefined;
    await run("UserPromptSubmit", { prompt: "go on" });
    expect(pending).toMatchObject([{ kind: "cancel", sessionId: session.session_id }]);
  });

  test("Notification: only idle_prompt counts", async () => {
    await run("Notification", { notification_type: "permission_prompt" });
    await run("Notification", { notification_type: "idle_prompt" });
    expect(calls.map((c) => c.name)).toEqual(["Idle"]);
  });

  test("PermissionRequest: a tool's ping, but none for AskUserQuestion's dialog", async () => {
    await run("PermissionRequest", { tool_name: "AskUserQuestion", tool_input: {} });
    await run("PermissionRequest", { tool_name: "Bash", tool_input: { command: "make" } });
    expect(calls).toMatchObject([
      { name: "PermissionRequest", body: { tool: "Bash", input: { command: "make" } } },
    ]);
  });

  test("PreToolUse: AskUserQuestion's questions; any other tool, nothing", async () => {
    const questions = [{ question: "Which?", options: [{ label: "A" }] }];
    await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    await run("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions } });
    expect(calls).toMatchObject([{ name: "Question", body: { questions } }]);
    expect(printed).toEqual([]);
  });

  test("StopFailure and SessionEnd pass on their error and reason", async () => {
    await run("StopFailure", { error: "rate_limit" });
    await run("SessionEnd", { reason: "prompt_input_exit" });
    expect(calls).toMatchObject([
      { name: "StopFailure", body: { error: "rate_limit" } },
      { name: "SessionEnd", body: { reason: "prompt_input_exit" }, timeoutMs: 1000 },
    ]);
  });
});

test("a session /new started: its stop is a finish at once, with no summary to wait for (F29)", async () => {
  const transcript = join(dir, "from-chat.jsonl");
  // In claude -p this hook blocks, so the stop's summary isn't written yet.
  writeFileSync(transcript, new Transcript().prompt("p1").assistant("Here are the files.").jsonl());
  respond = (name) => (name === "Stop" ? { generation: 2 } : {});
  const stop = {
    transcript_path: transcript,
    prompt_id: "p1",
    last_assistant_message: "Here are the files.",
  };
  const started = Date.now();
  await run("Stop", stop, { fromChat: true });
  expect(Date.now() - started).toBeLessThan(400);
  expect(calls.find((call) => call.name === "StopResult")?.body).toMatchObject({
    generation: 2,
    outcome: "finish",
    text: "Here are the files.",
  });
});
