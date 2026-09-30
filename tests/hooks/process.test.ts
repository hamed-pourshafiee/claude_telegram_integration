import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoCopy } from "../helpers/repo-copy.ts";
import { Transcript } from "../helpers/transcript.ts";
import { until } from "../helpers/wait.ts";

// Plan 2.7, with real processes: a served session's hooks, run as Claude Code runs them, in a
// throwaway copy of the repo whose broker is not paired (so nothing reaches Telegram).
const copy = new RepoCopy();
const project = join(copy.sandbox, "app");
mkdirSync(project);
afterAll(() => copy.remove());
const env = { CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };

function hook(event: string, input: Record<string, unknown>) {
  const stdin = JSON.stringify({ session_id: "proc-session", hook_event_name: event, ...input });
  return copy.run("hooks", [event], { cwd: project, stdin, env });
}
const brokerEvents = (event: string) =>
  copy.logged("broker").filter((entry) => entry.event === event);

test("UserPromptSubmit with no broker running doesn't start one", () => {
  expect(hook("UserPromptSubmit", { prompt: "hi" })).toMatchObject({ exitCode: 0, stdout: "" });
  expect(copy.brokerPids()).toEqual([]);
});

test("a subagent's Stop is skipped: no broker, no report", () => {
  expect(hook("Stop", { agent_id: "agent-1", last_assistant_message: "x" }).exitCode).toBe(0);
  expect(copy.brokerPids()).toEqual([]);
});

test("Stop: the hook finds the finish in the transcript and the broker records it", async () => {
  const transcript = join(project, "transcript.jsonl");
  writeFileSync(transcript, new Transcript().prompt("p9").assistant("All done.").summary().jsonl());
  const input = {
    transcript_path: transcript,
    prompt_id: "p9",
    last_assistant_message: "All done.",
  };
  const run = hook("Stop", input);
  expect(run).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  expect(await until(() => brokerEvents("notice.skipped").length > 0)).toBe(true);
  expect(brokerEvents("stop.result")).toMatchObject([
    { session: "proc-session", generation: 1, outcome: "finish", current: true },
  ]);
  expect(brokerEvents("notice.skipped")).toMatchObject([{ kind: "finish", reason: "not paired" }]);
  const logs = JSON.stringify([copy.logged("broker"), copy.logged("hooks")]);
  expect(logs).not.toContain("All done.");
}, 20_000);

test("the session's title in its transcript comes with the hook's call, and the broker keeps it (plan 7.2)", async () => {
  const transcript = join(project, "titled.jsonl");
  writeFileSync(transcript, new Transcript().prompt("p1").assistant("Hi.").jsonl());
  const title = { type: "ai-title", aiTitle: "Fix the login bug", sessionId: "proc-session" };
  appendFileSync(transcript, `${JSON.stringify(title)}\n`);
  expect(hook("SessionStart", { transcript_path: transcript, source: "startup" }).exitCode).toBe(0);
  const stored = () => {
    const db = new Database(copy.state.db, { readonly: true });
    try {
      const row = db.query("SELECT title FROM sessions WHERE id = 'proc-session'").get();
      return (row as { title?: string } | null)?.title;
    } finally {
      db.close();
    }
  };
  expect(await until(() => stored() === "Fix the login bug", 5000)).toBe(true);
});
