import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask, AskState } from "../../src/broker/asks.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import type { AskInput } from "../../src/broker/questions.ts";
import { sessionList } from "../../src/broker/session-list.ts";
import { type SessionRef, Sessions } from "../../src/broker/sessions.ts";
import type { Waiter } from "../../src/broker/waiters.ts";

// Plan 7.3: /sessions, the open sessions and what each is doing. Only those whose Claude still runs
// (F18): a session a crash left open is not listed.
const dir = mkdtempSync(join(tmpdir(), "tg-session-list-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;
/** Claude processes that run; any other pid has gone. */
const RUNNING = new Set([101, 102, 103, 104, 105, 106, 107]);

/** The sessions, with a clock for their stops. */
function world() {
  files += 1;
  let clock = NOW;
  const sessions = new Sessions(
    BrokerDb.open(join(dir, `list-${files}.db`)),
    () => new Date(clock),
  );
  const waiters: Waiter[] = [];
  const asks: Ask[] = [];
  const open = (id: string, pid: number, title?: string) => {
    const ref: SessionRef = { id, projectDir: `/work/${id}`, entrypoint: "claude-vscode" };
    sessions.touch({ ...ref, claudePid: pid, ...(title === undefined ? {} : { title }) });
  };
  const stoppedAt = (id: string, at: number) => {
    clock = at;
    sessions.stop(id);
    clock = NOW;
  };
  const answer = () =>
    sessionList({
      sessions,
      waiters: { listening: () => waiters },
      asks: { inState: (states) => asks.filter((ask) => states.includes(ask.state)) },
      alive: (pid) => RUNNING.has(pid),
      now: () => NOW,
    });
  const list = () => answer().text;
  /** Each button under the list: its text and its data. */
  const buttons = () =>
    (answer().reply_markup?.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);
  return { sessions, waiters, asks, open, stoppedAt, list, buttons };
}

const waiter = (sessionId: string, claudePid: number): Waiter => ({
  sessionId,
  generation: 1,
  pid: 900,
  claudePid,
  state: "waiting",
  updateId: undefined,
  createdAt: NOW,
});
const question: AskInput = {
  title: undefined,
  questions: [],
  plan: undefined,
  permission: undefined,
};
const plan: AskInput = { ...question, plan: "1. Read the code" };
const permission: AskInput = {
  ...question,
  permission: { tool: "Bash", input: { command: "npm test" }, cwd: "/work", hash: "abc" },
};
const ask = (sessionId: string, state: AskState, input: AskInput, claudePid = 0): Ask => ({
  id: `ask-${sessionId}`,
  sessionId,
  toolUseId: "toolu_1",
  pid: 900,
  claudePid,
  state,
  input,
  told: false,
  createdAt: NOW - MIN,
});

describe("which sessions are listed", () => {
  test("only those whose Claude runs, or whose waiting hook's Claude does; never one that ended", () => {
    const { sessions, waiters, asks, open, list } = world();
    open("running", 101, "Runs");
    open("crashed", 999, "Crashed at night");
    open("unknown", 0, "From before the update");
    open("waits", 0, "Waits for a reply");
    waiters.push(waiter("waits", 102));
    open("asks", 0, "Asks at the Mac");
    asks.push(ask("asks", "local", question, 103));
    open("ended", 104, "Ended");
    sessions.end("ended");
    const text = list();
    expect(text).toStartWith("3 open sessions:\n");
    for (const name of ["Runs", "Waits for a reply", "Asks at the Mac"])
      expect(text).toContain(name);
    for (const name of ["Crashed", "From before", "Ended"]) expect(text).not.toContain(name);
  });

  test("none open says so", () => {
    const { open, list, buttons } = world();
    open("crashed", 999);
    expect(list()).toBe("No sessions are open.");
    expect(buttons()).toEqual([]);
  });
});

describe("what each is doing", () => {
  test("what needs you first: asked here, then waiting for a reply, at the Mac, working, stopped", () => {
    const { sessions, waiters, asks, open, stoppedAt, list, buttons } = world();
    open("idle", 101, "Tidy the docs");
    stoppedAt("idle", NOW - 125 * MIN);
    open("works", 102, "Fix the login bug");
    stoppedAt("works", NOW - 20 * MIN);
    sessions.prompted("works", NOW - 3 * MIN);
    open("mac", 103, "Plan the release");
    asks.push(ask("mac", "local", plan));
    open("replies", 104, "Hello.py markdown note");
    stoppedAt("replies", NOW - 5 * MIN);
    waiters.push(waiter("replies", 104));
    open("allow", 105, "Run the tests");
    asks.push(ask("allow", "remote", permission));
    open("choose", 106, "Pick a library");
    asks.push(ask("choose", "remote", question));
    open("new", 107);
    expect(list()).toBe(
      [
        "7 open sessions:",
        "🔐 Run the tests: waits for your answer here",
        "❓ Pick a library: waits for your answer here",
        "✅ Hello.py markdown note: finished 5 min ago, waits for your reply",
        "🖥 Plan the release: a plan waits at the Mac",
        "⏳ Fix the login bug: working for 3 min",
        "💤 Tidy the docs: stopped 2 h 5 min ago",
        "💤 new · new: idle",
        "",
        "Tap one to write to it.",
        "💤 A stopped session takes a message again once it's used at the Mac.",
      ].join("\n"),
    );
    // Plan 7.4: a button for each session that can take a message, now or when its turn ends.
    expect(buttons()).toEqual([
      ["🔐 Run the tests", "write:allow"],
      ["❓ Pick a library", "write:choose"],
      ["✅ Hello.py markdown note", "write:replies"],
      ["🖥 Plan the release", "write:mac"],
      ["⏳ Fix the login bug", "write:works"],
    ]);
  });
});

describe("names and length", () => {
  test("sessions of the same title get the start of their id; a long list is cut", () => {
    const { waiters, open, list, buttons } = world();
    open("aaaa1111", 101, "Fix the bug");
    open("bbbb2222", 102, "Fix the bug");
    waiters.push(waiter("bbbb2222", 102));
    expect(list()).toStartWith(
      "2 open sessions:\n✅ Fix the bug · bbbb: waits for your reply\n💤 Fix the bug · aaaa: idle\n",
    );
    expect(buttons()).toEqual([["✅ Fix the bug · bbbb", "write:bbbb2222"]]);
    for (let at = 0; at < 31; at += 1) open(`many-${at}`, 103, `Session ${at}`);
    const lines = list().split("\n");
    expect(lines[0]).toBe("33 open sessions:");
    expect(lines[31]).toBe("…and 3 more");
    expect(buttons()).toHaveLength(1);
  });
});
