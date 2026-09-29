import { beforeEach, describe, expect, test } from "bun:test";
import { HANDLERS, type HookContext } from "../../src/hooks/events.ts";
import { parseHookInput } from "../../src/shared/hook-input.ts";
import { noLog } from "../../src/shared/log.ts";

// Phase 5 (D9): the PermissionRequest hook, against a stand-in broker that records the calls.
const session = {
  session_id: "b1e81638",
  project_dir: "/work/sandbox",
  entrypoint: "claude-vscode",
};
const npmTest = { command: "npm test", description: "Run the tests" };

let calls: { name: string; body: Record<string, unknown>; timeoutMs: number | undefined }[];
let printed: string[];
let respond: (name: string) => unknown;
beforeEach(() => {
  [calls, printed] = [[], []];
  respond = () => ({});
});

interface RunOptions {
  readonly wait?: boolean;
  readonly signal?: AbortSignal;
  readonly fields?: Record<string, unknown>;
}

async function run(options: RunOptions = {}) {
  const input = parseHookInput({
    session_id: session.session_id,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: npmTest,
    cwd: "/work/sandbox/app",
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
  };
  await HANDLERS.PermissionRequest?.(context);
}

const answered = (answer: string) => (name: string) =>
  name === "Ask"
    ? { ok: true, state: "answered", answers: { "Allow this?": answer } }
    : { ok: true, delivered: true };
const decision = () => JSON.parse(printed[0] ?? "{}").hookSpecificOutput;
const names = () => calls.map((call) => call.name);

describe("Bash, Edit and Write, with --wait", () => {
  test("allowed once from the chat: the dialog's decision, allow (F5); never always", async () => {
    respond = answered("Allow once");
    await run();
    expect(names()).toEqual(["Ask", "AskConfirm"]);
    expect(calls[0]?.body).toMatchObject({
      ...session,
      tool_use_id: expect.stringMatching(/^perm_[0-9a-f-]{36}$/),
      input: { permission: { tool: "Bash", input: npmTest, cwd: "/work/sandbox/app" } },
      claude_pid: 1234,
    });
    expect(decision()).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    });
  });

  test("denied, with or without your reason", async () => {
    respond = answered("Deny");
    await run();
    expect(decision().decision).toEqual({
      behavior: "deny",
      message: "The user denied this from Telegram.",
    });
    printed = [];
    respond = answered("Not on main");
    await run();
    expect(decision().decision).toEqual({
      behavior: "deny",
      message: "The user denied this from Telegram: Not on main",
    });
  });

  test("its timeout (SIGTERM): no decision, and the broker hears of it", async () => {
    const terminated = new AbortController();
    respond = (name) => (name === "Ask" ? { ok: true, state: "waiting" } : { ok: true });
    setTimeout(() => terminated.abort(), 30);
    await run({ signal: terminated.signal });
    expect(names().at(-1)).toBe("AskEnd");
    expect(printed).toEqual([]);
  });

  test("answered at the Mac (sent back as local): no decision; the dialog's answer stands", async () => {
    respond = () => ({ ok: true, state: "local" });
    await run();
    expect(printed).toEqual([]);
  });
});

describe("prompts the hook only pings", () => {
  test("a tool outside the policy (D9) gets the 🔐 ping only, and its dialog", async () => {
    for (const tool of ["WebFetch", "mcp__GitLab__glab_mr_merge", "NotebookEdit"]) {
      await run({ fields: { tool_name: tool, tool_input: { url: "https://example.com" } } });
    }
    expect(names()).toEqual(["PermissionRequest", "PermissionRequest", "PermissionRequest"]);
    expect(printed).toEqual([]);
  });

  test("without --wait: the 🔐 ping only; questions and plans are the question hook's", async () => {
    await run({ wait: false });
    for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
      await run({ fields: { tool_name: tool, tool_input: {} } });
    }
    expect(names()).toEqual(["PermissionRequest"]);
  });
});
