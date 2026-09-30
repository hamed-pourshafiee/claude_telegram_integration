import { Database, SQLiteError } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Pairing } from "../../src/broker/pairing.ts";
import { MODE_KEY } from "../../src/broker/presence.ts";
import { countOurs } from "../../src/ctl/install.ts";
import { installHooks, uninstallBridge } from "../../src/ctl/setup.ts";
import type { Log } from "../../src/shared/log.ts";
import { ensureStateDir, isDisabled } from "../../src/shared/state.ts";
import { FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { BASE_ENV, RepoCopy } from "../helpers/repo-copy.ts";
import { Transcript } from "../helpers/transcript.ts";
import { until } from "../helpers/wait.ts";

// Plan 6.1's pass check, with real processes: ctl uninstall while a Stop waiter, a question held in the
// chat and a permission request all wait, after a settings edit made since install (design §6). The
// copy's broker is paired and in away mode, and talks to a local stand-in for the Bot API. The settings
// file lies in the copy, never in ~/.claude. The test process stands in for Claude Code.
const CHAT = 4242;
const fake = new FakeTelegram();
const copy = new RepoCopy({ apiBase: fake.url });
const project = join(copy.sandbox, "app");
mkdirSync(project);
const children: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  copy.remove();
  fake.stop();
});

const env = { ...BASE_ENV, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };
const installPaths = {
  settingsFile: join(copy.root, "claude", "settings.json"),
  backupDir: join(copy.state.dir, "backups"),
  bun: process.execPath,
  repoRoot: copy.root,
};
const bridge = {
  hooks: installPaths,
  state: copy.state,
  launch: {
    bun: process.execPath,
    main: copy.brokerMain,
    bunfig: join(copy.root, "bunfig.toml"),
    cwd: copy.root,
  },
};
const THEIRS = { hooks: [{ type: "command", command: "/usr/local/bin/notify" }] };

const QUESTION = {
  session_id: "question-session",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_question",
  tool_input: {
    questions: [
      {
        question: "Red or blue?",
        header: "Color",
        multiSelect: false,
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue", description: "Cool" },
        ],
      },
    ],
  },
};
const PERMISSION = {
  session_id: "permission-session",
  tool_name: "Bash",
  tool_input: { command: "npm test", description: "Run the tests" },
  permission_suggestions: [],
};

/** Paired, and in /away mode, before its broker first starts. */
function pairAway(): void {
  ensureStateDir(copy.state);
  const db = BrokerDb.open(copy.state.db);
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: CHAT, name: "Test (@test)" });
  db.setMeta(MODE_KEY, "away");
  db.close();
}

/** Telegram's side: polls that find nothing, and a new message id for every message sent. */
function answerLikeTelegram(): void {
  fake.fallback("getUpdates", { json: { ok: true, result: [] }, delayMs: 300 });
  const chat = { id: CHAT, type: "private" };
  const sent = Array.from({ length: 20 }, (_, n) => ok({ message_id: 100 + n, date: 0, chat }));
  fake.answer("sendMessage", ...sent);
}

/** A hook as Claude Code runs it, left waiting: its input on stdin, the test process its parent. */
function hook(event: string, input: object) {
  const stdin = JSON.stringify({ hook_event_name: event, cwd: project, ...input });
  const child = Bun.spawn(copy.command("hooks", [event, "--wait"]), {
    cwd: project,
    env,
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

/** A Stop hook after a real finish, which then waits for a reply. */
function waitingStop() {
  const transcript = join(project, "stop-session.jsonl");
  writeFileSync(transcript, new Transcript().prompt("p1").assistant("All done.").summary().jsonl());
  return hook("Stop", {
    session_id: "stop-session",
    transcript_path: transcript,
    prompt_id: "p1",
    last_assistant_message: "All done.",
  });
}

/** A state in the copy's database, read on the side; undefined while the broker is still making it. */
function stateOf(table: "waiters" | "asks", session: string): string | undefined {
  if (!existsSync(copy.state.db)) return undefined;
  const db = new Database(copy.state.db, { readonly: true });
  try {
    const sql = `SELECT state FROM ${table} WHERE session_id = ?`;
    return db.query<{ state: string }, [string]>(sql).get(session)?.state;
  } catch (error) {
    if (error instanceof SQLiteError) return undefined;
    throw error;
  } finally {
    db.close();
  }
}

const settings = () => JSON.parse(readFileSync(installPaths.settingsFile, "utf8"));
const results = (event: string) =>
  copy
    .logged("hooks")
    .filter((entry) => entry.event === event)
    .map((entry) => entry.result);

/** Installed, then edited by hand: a setting and a hook of the user's own. */
function installThenEdit(): void {
  expect(installHooks(installPaths, false, () => undefined)).toMatchObject({ ok: true });
  const edited = settings();
  edited.model = "opus";
  edited.hooks.Stop.push(THEIRS);
  writeFileSync(installPaths.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
}

/** How each hook ended: its exit code, and what it told Claude (stdout) or woke it with (stderr). */
function endings(hooks: readonly ReturnType<typeof hook>[]) {
  return Promise.all(
    hooks.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
}

test("uninstall while a stop, a question and a permission prompt wait: each leaves with no decision", async () => {
  installThenEdit();
  pairAway();
  answerLikeTelegram();
  const hooks = [
    waitingStop(),
    hook("PreToolUse", QUESTION),
    hook("PermissionRequest", PERMISSION),
  ];
  const held = () =>
    stateOf("waiters", "stop-session") === "waiting" &&
    stateOf("asks", "question-session") === "remote" &&
    stateOf("asks", "permission-session") === "remote";
  expect(await until(held, 20_000)).toBe(true);
  expect(fake.calls("sendMessage")).toHaveLength(3); // the ✅, the ❓ and the 🔐
  // The running broker's, not a race loser's that still waits for the lock.
  const broker = (await copy.health())?.pid;
  const steps: string[] = [];
  const log: Log = (event) => steps.push(event);

  const outcome = await uninstallBridge(bridge, false, log);
  const uninstalled = Date.now();
  expect(outcome.ok).toBe(true);
  expect(outcome.text).toContain("disabled: hooks do nothing now");
  expect(outcome.text).toContain(`removed 9 hooks from ${installPaths.settingsFile}`);
  expect(outcome.text).toContain(`the broker: stopped (pid ${broker})`);
  expect(steps).toEqual(["bridge.disabled", "hooks.uninstalled"]);

  // Nothing on stdout (no answers, no decision) and nothing on stderr (no wake).
  expect(await endings(hooks)).toEqual(Array(3).fill({ code: 0, stdout: "", stderr: "" }));
  expect(Date.now() - uninstalled).toBeLessThan(10_000);
  expect(results("hook.waited")).toEqual(["disabled"]);
  for (const event of ["hook.asked", "hook.permission"]) {
    expect(results(event)).toEqual([expect.stringMatching(/^(disabled|no broker)$/)]);
  }
  // Only ours went: the edit made since install stays.
  expect(countOurs(settings(), copy.root)).toBe(0);
  expect(settings()).toMatchObject({ model: "opus", hooks: { Stop: [THEIRS] } });
}, 60_000);

test("after uninstall, nothing starts the broker again, and a new hook does nothing", async () => {
  expect(isDisabled(copy.state)).toBe(true);
  const session = copy.hook("SessionStart", project, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" });
  expect(session).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  await Bun.sleep(2500);
  expect(copy.brokerPids()).toEqual([]);
  const events = copy.logged("broker").map((entry) => entry.event);
  expect(events.filter((event) => event === "broker.started")).toHaveLength(1);
  expect(events.filter((event) => event === "broker.stopped")).toHaveLength(1);
  // After the stop, only brokers that gave up: spawned in the hooks' race, they found the flag.
  const after = events.slice(events.indexOf("broker.stopped") + 1);
  expect(after.filter((event) => event !== "broker.not-started")).toEqual([]);
}, 30_000);
