import { Database, SQLiteError } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ENV, RepoCopy } from "../helpers/repo-copy.ts";
import { Transcript } from "../helpers/transcript.ts";
import { until } from "../helpers/wait.ts";

// Plan 3.1 with real processes: a Stop hook installed with --wait, against a real broker, in a throwaway
// copy of the repo whose broker is not paired (so nothing reaches Telegram). The test process stands in
// for Claude Code: it is the hook's parent.
const copy = new RepoCopy();
const project = join(copy.sandbox, "app");
mkdirSync(project);
afterAll(() => copy.remove());
const env = { ...BASE_ENV, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };

const events = (log: "broker" | "hooks", event: string) =>
  copy.logged(log).filter((entry) => entry.event === event);

/** A Stop hook after a real finish, left waiting in the background. */
function waitingStop(session: string) {
  const transcript = join(project, `${session}.jsonl`);
  writeFileSync(transcript, new Transcript().prompt("p1").assistant("All done.").summary().jsonl());
  const input = {
    session_id: session,
    hook_event_name: "Stop",
    transcript_path: transcript,
    prompt_id: "p1",
    last_assistant_message: "All done.",
  };
  return Bun.spawn(copy.command("hooks", ["Stop", "--wait"]), {
    cwd: project,
    env,
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** The waiter's state in the copy's broker database, read on the side; none before the broker made it. */
function waiterState(session: string): string | undefined {
  if (!existsSync(copy.state.db)) return undefined;
  const db = new Database(copy.state.db, { readonly: true });
  try {
    const row = db
      .query<{ state: string }, [string]>("SELECT state FROM waiters WHERE session_id = ?")
      .get(session);
    return row?.state;
  } catch (error) {
    // The broker is still creating its tables: the caller polls again.
    if (error instanceof SQLiteError) return undefined;
    throw error;
  } finally {
    db.close();
  }
}

test("SIGTERM (the panel closed): the hook exits at once with no decision, and its waiter ends", async () => {
  const hook = waitingStop("sigterm-session");
  expect(await until(() => waiterState("sigterm-session") === "waiting", 15_000)).toBe(true);
  hook.kill("SIGTERM");
  const started = Date.now();
  expect(await hook.exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await new Response(hook.stderr).text()).toBe("");
  expect(await until(() => waiterState("sigterm-session") === "ended")).toBe(true);
  expect(events("hooks", "hook.waited")).toMatchObject([{ result: "terminated" }]);
  expect(events("broker", "waiter.ended")).toMatchObject([
    { session: "sigterm-session", was: "waiting" },
  ]);
}, 30_000);

test("a broker crash after storing a reply: the hook starts a broker, gets it, confirms, wakes Claude", async () => {
  const hook = waitingStop("reply-session");
  expect(await until(() => waiterState("reply-session") === "waiting", 15_000)).toBe(true);
  // The poller stored a reply and the broker died before routing it.
  const db = new Database(copy.state.db);
  db.run(
    `INSERT INTO inbox (update_id, chat_id, message_id, text, received_at, state)
     VALUES (500, 1, 1, 'now say bye', 0, 'new')`,
  );
  db.close();
  for (const pid of copy.brokerPids()) process.kill(pid, "SIGKILL");
  expect(await hook.exited).toBe(2);
  expect(await new Response(hook.stderr).text()).toBe(
    "📨 Telegram reply from the user: now say bye\n",
  );
  expect(waiterState("reply-session")).toBe("delivered");
  const check = new Database(copy.state.db, { readonly: true });
  const reply = check.query("SELECT state, text FROM inbox WHERE update_id = 500").get();
  check.close();
  expect(reply).toEqual({ state: "delivered", text: "" });
  // Two brokers: the one the first test started, and the one this hook started after the crash.
  expect(events("broker", "broker.started")).toHaveLength(2);
  expect(events("broker", "reply.handed")).toMatchObject([
    { session: "reply-session", update: 500 },
  ]);
  expect(events("broker", "reply.confirmed")).toMatchObject([{ update: 500, delivered: true }]);
  expect(events("hooks", "hook.waited").at(-1)).toMatchObject({ result: "reply" });
}, 40_000);
