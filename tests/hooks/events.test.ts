import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS, type HookContext, sessionNote } from "../../src/hooks/events.ts";
import { parseHookInput } from "../../src/shared/hook-input.ts";
import { noLog } from "../../src/shared/log.ts";
import { Transcript } from "../helpers/transcript.ts";

// Plan 2.7: what each hook asks of the broker. The broker is a stand-in that records the calls.
const dir = mkdtempSync(join(tmpdir(), "tg-events-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = { session_id: "b1e81638", project_dir: dir, entrypoint: "claude-vscode" };

let calls: { name: string; body: Record<string, unknown>; timeoutMs: number | undefined }[];
let printed: string[];
let started: number;
let brokerUp: boolean;
beforeEach(() => {
  [calls, printed, started, brokerUp] = [[], [], 0, true];
});

async function run(event: string, fields: Record<string, unknown> = {}, answer: unknown = {}) {
  const input = parseHookInput({
    session_id: session.session_id,
    hook_event_name: event,
    ...fields,
  });
  if (input === undefined) throw new Error("bad test input");
  const context: HookContext = {
    input,
    session,
    log: noLog,
    ensureBroker: () => {
      started += 1;
      return Promise.resolve(brokerUp);
    },
    call: (name, body, timeoutMs) => {
      calls.push({ name, body: { ...body }, timeoutMs });
      return Promise.resolve(answer);
    },
    print: (text) => printed.push(text),
    classify: { timeoutMs: 500, pollMs: 20 },
  };
  await HANDLERS[event]?.(context);
}

describe("SessionStart", () => {
  test("registers the session and adds the note, with the paired user's name", async () => {
    await run("SessionStart", {}, { name: "Hamed" });
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
    const transcript = join(dir, "finish.jsonl");
    writeFileSync(transcript, new Transcript().prompt("p1").assistant("Done.").summary().jsonl());
    const task = {
      type: "shell",
      status: "running",
      description: "Dev server",
      command: "npm run dev",
    };
    const fields = {
      transcript_path: transcript,
      prompt_id: "p1",
      last_assistant_message: "Done.",
      background_tasks: [task],
    };
    await run("Stop", fields, { generation: 7 });
    expect(calls.map((c) => c.name)).toEqual(["Stop", "StopResult"]);
    expect(calls[1]?.body).toEqual({
      ...session,
      generation: 7,
      outcome: "finish",
      text: "Done.",
      tasks: [task],
    });
  });

  test("no broker: no classification, no calls", async () => {
    brokerUp = false;
    await run("Stop", { last_assistant_message: "Done." });
    expect(calls).toEqual([]);
  });
});

describe("the others", () => {
  test("UserPromptSubmit: the cancel, quickly, without starting a broker", async () => {
    await run("UserPromptSubmit", { prompt: "go on" });
    expect(calls).toEqual([{ name: "UserPromptSubmit", body: session, timeoutMs: 1000 }]);
    expect(started).toBe(0);
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
