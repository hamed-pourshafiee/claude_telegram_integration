import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHookInput, parseTasks } from "../../src/shared/hook-input.ts";

// The hook inputs recorded in step 1.4 (tests/fixtures/hooks/), read the way the hooks read them.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "hooks", name), "utf8")).input;

describe("recorded inputs", () => {
  test("Stop: its last message, prompt and transcript; no background tasks", () => {
    const input = parseHookInput(fixture("claude-vscode/Stop.json"));
    expect(input).toMatchObject({
      event: "Stop",
      sessionId: "b1e81638-e169-4a47-9891-766f05aaa292",
      promptId: "7f21fa1e-4e63-4ac1-9c49-a7b61e02ec25",
      agentId: undefined,
      backgroundTasks: [],
    });
    expect(input?.lastAssistantMessage).toStartWith("Hi!");
    expect(input?.transcriptPath).toEndWith(".jsonl");
  });

  test("PermissionRequest, Notification, StopFailure and SessionEnd: their own fields", () => {
    expect(parseHookInput(fixture("claude-vscode/PermissionRequest-Bash.json"))).toMatchObject({
      toolName: "Bash",
      toolInput: { command: "touch permission-test.txt" },
    });
    expect(parseHookInput(fixture("cli/Notification-idle_prompt.json"))).toMatchObject({
      notificationType: "idle_prompt",
    });
    expect(parseHookInput(fixture("sdk-cli/StopFailure.json"))?.error).toBe("model_not_found");
    expect(parseHookInput(fixture("cli/SessionEnd-prompt_input_exit.json"))?.reason).toBe(
      "prompt_input_exit",
    );
  });
});

describe("what isn't a usable input", () => {
  test("no session_id, or not an object: undefined", () => {
    expect(parseHookInput({ hook_event_name: "Stop" })).toBeUndefined();
    expect(parseHookInput({ session_id: "" })).toBeUndefined();
    expect(parseHookInput([{ session_id: "x" }])).toBeUndefined();
  });

  test("a subagent's input has agent_id; an empty one counts as none", () => {
    expect(parseHookInput({ session_id: "s", agent_id: "agent-7" })?.agentId).toBe("agent-7");
    expect(parseHookInput({ session_id: "s", agent_id: "" })?.agentId).toBeUndefined();
  });
});

test("background tasks, as Claude Code 2.1.283 describes them", () => {
  const tasks = parseTasks([
    {
      id: "b1",
      type: "shell",
      status: "running",
      description: "Dev server",
      command: "npm run dev",
    },
    {
      id: "a1",
      type: "subagent",
      status: "running",
      description: "Explore",
      agent_type: "Explore",
    },
    "not a task",
  ]);
  expect(tasks).toEqual([
    { type: "shell", status: "running", description: "Dev server", command: "npm run dev" },
    { type: "subagent", status: "running", description: "Explore", command: undefined },
  ]);
});
