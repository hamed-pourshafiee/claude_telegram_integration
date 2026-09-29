import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS, type HookContext } from "../../src/hooks/events.ts";
import { parseHookInput } from "../../src/shared/hook-input.ts";
import { noLog } from "../../src/shared/log.ts";

// Plan 4.1: the question hook (PreToolUse on AskUserQuestion) and PostToolUse, against a stand-in
// broker that records the calls.
const session = {
  session_id: "b1e81638",
  project_dir: "/work/sandbox",
  entrypoint: "claude-vscode",
};
const toolInput = {
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [{ label: "Red" }, { label: "Blue" }],
      multiSelect: false,
    },
  ],
};
const answers = { "Which color do you prefer?": "Blue" };

type Respond = (name: string) => unknown;
let calls: { name: string; body: Record<string, unknown>; timeoutMs: number | undefined }[];
let printed: string[];
let respond: Respond;
beforeEach(() => {
  [calls, printed] = [[], []];
  respond = () => ({});
});

interface RunOptions {
  readonly wait?: boolean;
  readonly signal?: AbortSignal;
  readonly fields?: Record<string, unknown>;
  readonly claudeDir?: string;
}

async function run(event: string, options: RunOptions = {}) {
  const input = parseHookInput({
    session_id: session.session_id,
    hook_event_name: event,
    tool_name: "AskUserQuestion",
    tool_input: toolInput,
    tool_use_id: "toolu_01",
    ...options.fields,
  });
  if (input === undefined) throw new Error("bad test input");
  const context: HookContext = {
    input,
    session,
    log: noLog,
    ensureBroker: () => Promise.resolve(true),
    call: async (name, body, timeoutMs) => {
      calls.push({ name, body: { ...body }, timeoutMs });
      // A held Ask comes back after a while, as the broker's does.
      if (name === "Ask") await Bun.sleep(5);
      return respond(name);
    },
    print: (text) => printed.push(text),
    wait: options.wait ?? true,
    signal: options.signal ?? new AbortController().signal,
    rewake: () => undefined,
    claudePid: 1234,
    claudeAlive: () => true,
    disabled: () => false,
    pending: () => undefined,
    waiting: { retryMs: 5, watchMs: 20 },
    ...(options.claudeDir === undefined ? {} : { claudeDir: options.claudeDir }),
  };
  await HANDLERS[event]?.(context);
}

const names = () => calls.map((call) => call.name);

describe("PreToolUse with --wait", () => {
  test("answered in the chat: confirmed, then printed for Claude as allow + answers (F4)", async () => {
    respond = (name) =>
      name === "Ask" ? { ok: true, state: "answered", answers } : { ok: true, delivered: true };
    await run("PreToolUse");
    expect(names()).toEqual(["Ask", "AskConfirm"]);
    expect(calls[0]?.body).toEqual({
      ...session,
      tool_use_id: "toolu_01",
      input: toolInput,
      pid: process.pid,
      claude_pid: 1234,
    });
    expect(printed.map((text) => JSON.parse(text))).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Answered from Telegram",
          updatedInput: { ...toolInput, answers },
        },
      },
    ]);
  });
});

describe("PreToolUse with --wait, not answered in the chat: no output, so the dialog opens", () => {
  test("held, then sent to the Mac", async () => {
    let asks = 0;
    respond = () => {
      asks += 1;
      return { ok: true, state: asks < 3 ? "waiting" : "local" };
    };
    await run("PreToolUse");
    expect(names()).toEqual(["Ask", "Ask", "Ask"]);
    expect(printed).toEqual([]);
  });

  test("SIGTERM while waiting (Esc, or the timeout): the broker hears of it; no output", async () => {
    const terminated = new AbortController();
    respond = (name) => (name === "Ask" ? { ok: true, state: "waiting" } : { ok: true });
    setTimeout(() => terminated.abort(), 30);
    await run("PreToolUse", { signal: terminated.signal });
    expect(names().at(-1)).toBe("AskEnd");
    expect(calls.at(-1)).toMatchObject({
      body: { ...session, tool_use_id: "toolu_01" },
      timeoutMs: 1000,
    });
    expect(printed).toEqual([]);
  });

  test("no broker answers the first Ask: the dialog opens at once", async () => {
    respond = () => undefined;
    await run("PreToolUse");
    expect(names()).toEqual(["Ask"]);
    expect(printed).toEqual([]);
  });

  test("answers the broker won't confirm are never printed", async () => {
    respond = (name) =>
      name === "Ask" ? { ok: true, state: "answered", answers } : { ok: true, delivered: false };
    await run("PreToolUse");
    expect(names()).toEqual(["Ask", "AskConfirm"]);
    expect(printed).toEqual([]);
  });

  test("without --wait, or without a tool_use_id: phase 2's ping only", async () => {
    await run("PreToolUse", { wait: false });
    await run("PreToolUse", { fields: { tool_use_id: undefined } });
    expect(names()).toEqual(["Question", "Question"]);
    expect(printed).toEqual([]);
  });
});

describe("PostToolUse", () => {
  test("AskUserQuestion answered: the broker closes it; another tool, nothing", async () => {
    await run("PostToolUse");
    await run("PostToolUse", { fields: { tool_name: "Bash" } });
    expect(calls).toEqual([
      { name: "Asked", body: { ...session, tool_use_id: "toolu_01" }, timeoutMs: 1000 },
    ]);
  });
});

describe("ExitPlanMode with --wait (plan 4.2)", () => {
  const plan = (fields: Record<string, unknown> = {}) => ({
    fields: {
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Plan", planFilePath: "/x.md" },
      ...fields,
    },
  });
  const answered = (answer: string) => (name: string) =>
    name === "Ask"
      ? { ok: true, state: "answered", answers: { "Approve this plan?": answer } }
      : { ok: true, delivered: true };
  const output = () => JSON.parse(printed[0] ?? "{}").hookSpecificOutput;

  test("approved: allowed as it is, so Claude leaves plan mode", async () => {
    respond = answered("Approve");
    await run("PreToolUse", plan());
    expect(calls[0]?.body.input).toEqual({ plan: "# Plan" });
    expect(output()).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Approved from Telegram",
    });
  });

  test("your words, or Keep planning: denied with them, so Claude keeps planning", async () => {
    respond = answered("Split step 2 in two");
    await run("PreToolUse", plan());
    expect(output()).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "The user wants changes to the plan before approving it: Split step 2 in two",
    });
    printed = [];
    respond = answered("Keep planning");
    await run("PreToolUse", plan());
    expect(output()).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("keep planning"),
    });
  });

  test("no plan in the input, and no plan file under ~/.claude: nothing asked, so the dialog opens", async () => {
    await run("PreToolUse", plan({ tool_input: {} }));
    await run("PreToolUse", plan({ tool_input: { planFilePath: "/etc/passwd.md" } }));
    await run("PreToolUse", plan({ tool_input: { plan: "  " } }));
    expect(calls).toEqual([]);
    expect(printed).toEqual([]);
  });

  test("without --wait nothing is sent: the dialog's 🔐 isn't pinged either", async () => {
    await run("PreToolUse", { ...plan(), wait: false });
    await run("PermissionRequest", plan());
    expect(calls).toEqual([]);
  });

  test("PostToolUse closes the call", async () => {
    await run("PostToolUse", plan());
    expect(names()).toEqual(["Asked"]);
  });
});

describe("a plan read from its file (plan 4.2)", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "tg-claude-dir-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "tg-elsewhere-"));
  afterAll(() => {
    for (const folder of [claudeDir, elsewhere]) rmSync(folder, { recursive: true, force: true });
  });
  mkdirSync(join(claudeDir, "plans"));
  const file = join(claudeDir, "plans", "a-plan.md");
  writeFileSync(file, "# From the file\n");

  test("no plan in the input: the one in its plan file, under ~/.claude, goes to the broker", async () => {
    respond = () => ({ ok: true, state: "local" });
    const fields = { tool_name: "ExitPlanMode", tool_input: { planFilePath: file } };
    await run("PreToolUse", { fields, claudeDir });
    expect(calls[0]?.body.input).toEqual({ plan: "# From the file\n" });
  });

  test("a plan file outside it, or one that isn't .md, is left to the dialog", async () => {
    // A real file, so only the folder keeps it out.
    const outside = join(elsewhere, "a-plan.md");
    writeFileSync(outside, "# Elsewhere\n");
    for (const planFilePath of [outside, join(claudeDir, "plans", "a-plan.txt")]) {
      await run("PreToolUse", {
        fields: { tool_name: "ExitPlanMode", tool_input: { planFilePath } },
        claudeDir,
      });
    }
    expect(calls).toEqual([]);
  });
});
