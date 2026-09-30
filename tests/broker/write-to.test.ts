import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask, AskState } from "../../src/broker/asks.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { Outbox } from "../../src/broker/outbox.ts";
import type { AskInput } from "../../src/broker/questions.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import type { Waiter } from "../../src/broker/waiters.ts";
import { writeTo } from "../../src/broker/write-to.ts";
import type { LogFields } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";

// Plan 7.4: a tap on a session under /sessions opens the reply box on a question linked to it, so what
// you send goes to that session (flow 4).
const dir = mkdtempSync(join(tmpdir(), "tg-write-to-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CHAT = 4242;
const RUNNING = new Set([101, 102, 103]);
let files = 0;
let sessions: Sessions;
let outbox: Outbox;
let waiters: Waiter[];
let asks: Ask[];
let sent: SendMessageParams[];
let answered: AnswerCallbackQueryParams[];
let logged: { event: string; fields: LogFields }[];
let refuse: boolean;
beforeEach(() => {
  files += 1;
  const db = BrokerDb.open(join(dir, `write-${files}.db`));
  [sessions, outbox] = [new Sessions(db), new Outbox(db)];
  [waiters, asks, sent, answered, logged, refuse] = [[], [], [], [], [], false];
});

const telegram = {
  sendMessage: (params: SendMessageParams) => {
    if (refuse) return Promise.reject(new Error("Bad Request: chat not found"));
    sent.push(params);
    return Promise.resolve({
      message_id: 70 + sent.length,
      date: 0,
      chat: { id: CHAT, type: "private" },
    });
  },
  answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
    answered.push(params);
    return Promise.resolve();
  },
};
const tap = (data: string) =>
  writeTo(data, CHAT, "q1", {
    sessions,
    waiters: { listening: () => waiters },
    asks: { inState: (states) => asks.filter((ask) => states.includes(ask.state)) },
    alive: (pid) => RUNNING.has(pid),
    telegram,
    outbox,
    log: (event, fields) => logged.push({ event, fields }),
  });
const open = (id: string, title: string, claudePid = 101) =>
  sessions.touch({ id, projectDir: `/work/${id}`, entrypoint: "cli", title, claudePid });
const waiting = (sessionId: string) =>
  waiters.push({
    sessionId,
    generation: 1,
    pid: 900,
    claudePid: 101,
    state: "waiting",
    updateId: undefined,
    createdAt: 0,
  });
const question: AskInput = {
  title: undefined,
  questions: [],
  plan: undefined,
  permission: undefined,
};
const asking = (sessionId: string, state: AskState, input: AskInput) =>
  asks.push({
    id: `ask-${sessionId}`,
    sessionId,
    toolUseId: "toolu_1",
    pid: 900,
    claudePid: 101,
    state,
    input,
    told: false,
    createdAt: 0,
  });

test("a session waiting for a reply: the reply box opens on a question linked to it", async () => {
  open("replies", "Hello.py markdown note");
  sessions.stop("replies");
  waiting("replies");
  await tap("write:replies");
  expect(sent).toEqual([
    {
      chat_id: CHAT,
      text: "✏️ Your message for ✅ Hello.py markdown note\nIt goes in at once, and Claude carries on.",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "Message for Hello.py markdown note",
      },
    },
  ]);
  expect(outbox.find(CHAT, 71)).toEqual({ sessionId: "replies", generation: 1, kind: "write" });
  expect(answered).toEqual([{ callback_query_id: "q1" }]);
});

test("what your message will do, by what the session is doing", async () => {
  open("allow", "Run the tests");
  asking("allow", "remote", {
    ...question,
    permission: { tool: "Bash", input: { command: "npm test" }, cwd: "/work", hash: "abc" },
  });
  open("plan", "Plan the release");
  asking("plan", "remote", { ...question, plan: "1. Tag it" });
  open("choose", "Pick a library");
  asking("choose", "remote", question);
  open("mac", "Tidy the docs");
  asking("mac", "local", question);
  open("works", "Fix the login bug");
  sessions.prompted("works", Date.now());
  for (const id of ["allow", "plan", "choose", "mac", "works"]) await tap(`write:${id}`);
  expect(sent.map((params) => params.text.split("\n")[1])).toEqual([
    "It denies the permission it asks for, with your message as the reason.",
    "It tells Claude what to change in the plan.",
    "It answers the question it asks.",
    "Something waits at the Mac: your message goes in when this turn ends.",
    "It's working: your message goes in when this turn ends.",
  ]);
});

describe("no question, only a note on the tap", () => {
  test("a session that stopped, ended or whose Claude has gone, or a button that can't be read", async () => {
    open("idle", "Stopped long ago");
    sessions.stop("idle");
    open("ended", "Ended");
    sessions.end("ended");
    open("crashed", "Crashed", 999);
    for (const data of ["write:idle", "write:ended", "write:crashed", "write:../x", "write:"]) {
      await tap(data);
    }
    expect(sent).toEqual([]);
    expect(answered.map((params) => params.text)).toEqual([
      "That session has stopped: it takes a message again once it's used at the Mac.",
      "That session isn't open any more.",
      "That session isn't open any more.",
      "That session isn't open any more.",
      "That session isn't open any more.",
    ]);
  });

  test("Telegram refuses the question: the tap says so, and the failure is logged", async () => {
    open("works", "Fix the login bug");
    sessions.prompted("works", Date.now());
    refuse = true;
    await tap("write:works");
    expect(answered).toEqual([
      { callback_query_id: "q1", text: "The reply box didn't open. Try again." },
    ]);
    expect(logged.map((entry) => entry.event)).toEqual(["write.failed"]);
  });
});

test("the reply box's placeholder is cut to the 64 characters Telegram allows", async () => {
  open("long", `${"a".repeat(51)}🙂 and more words`);
  waiting("long");
  await tap("write:long");
  const markup = sent[0]?.reply_markup;
  const placeholder =
    markup !== undefined && "force_reply" in markup ? markup.input_field_placeholder : "";
  expect(placeholder).toBe(`Message for ${"a".repeat(51)}🙂`);
  expect(Array.from(placeholder ?? "")).toHaveLength(64);
});
