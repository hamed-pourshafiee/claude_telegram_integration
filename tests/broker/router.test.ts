import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { Inbox } from "../../src/broker/inbox.ts";
import { Outbox } from "../../src/broker/outbox.ts";
import { Relay } from "../../src/broker/relay.ts";
import { PICK_MS, Router } from "../../src/broker/router.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { Waiters } from "../../src/broker/waiters.ts";
import { noLog } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";
import { buttonRows } from "../helpers/buttons.ts";
import { noAskChat } from "../helpers/no-asks.ts";

// Plan 3.2 (flow 4): where each reply goes. Sessions A and B stop and wait, or are busy.
const dir = mkdtempSync(join(tmpdir(), "tg-router-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CHAT = 4242;
let files = 0;
let clock: number;
let sent: SendMessageParams[];
let answered: AnswerCallbackQueryParams[];
let told: string[];
let parts: ReturnType<typeof build>;
beforeEach(() => {
  files += 1;
  clock = 1_000_000;
  [sent, answered, told] = [[], [], []];
  parts = build();
});

function build() {
  const db = BrokerDb.open(join(dir, `router-${files}.db`));
  const sessions = new Sessions(db);
  const waiters = new Waiters(db);
  const inbox = new Inbox(db, () => clock);
  const outbox = new Outbox(db);
  const tell = (text: string) => {
    told.push(text);
    return Promise.resolve();
  };
  const relay = new Relay({
    db,
    sessions,
    waiters,
    inbox,
    tell,
    senderName: () => "Hamed",
    log: noLog,
  });
  const telegram = {
    sendMessage: (params: SendMessageParams) => {
      sent.push(params);
      return Promise.resolve({ message_id: 1, date: 0, chat: { id: CHAT, type: "private" } });
    },
    answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
      answered.push(params);
      return Promise.resolve();
    },
  };
  const now = () => clock;
  const router = new Router({
    relay,
    waiters,
    asks: noAskChat,
    inbox,
    outbox,
    sessions,
    telegram,
    log: noLog,
    now,
  });
  return { sessions, relay, inbox, outbox, router };
}

/** Session `id` stops, and its hook waits: the Wait's answer. */
function stopAndWait(id: string): Promise<Answer> {
  const { sessions, relay } = parts;
  sessions.touch({ id, projectDir: `/work/${id}`, entrypoint: "cli" });
  const generation = sessions.stop(id);
  return Promise.resolve(relay.wait({ session_id: id, generation, pid: 1, claude_pid: 1 }));
}

/** Session `id` is busy: it registered, and has no waiter. */
function busy(id: string): void {
  parts.sessions.touch({ id, projectDir: `/work/${id}`, entrypoint: "cli" });
}

let updates = 500;
/** You send `text`, maybe as a reply-to bot message `replyTo`; the poller stores it: its update id. */
function incoming(text: string, replyTo?: number): number {
  updates += 1;
  const reply = { updateId: updates, chatId: CHAT, messageId: updates, replyTo, text };
  parts.relay.accept(reply);
  return updates;
}

const body = (answer: Answer) => answer.body as Record<string, unknown>;
const texts = () => sent.map((message) => message.text);

describe("a plain message", () => {
  test("the single waiting session gets it", async () => {
    const waiting = stopAndWait("aaaa1111");
    await parts.router.route(incoming("now say bye"));
    expect(body(await waiting)).toMatchObject({ state: "reply", text: "now say bye" });
    expect(sent).toEqual([]);
  });

  test("nobody listening: you're told, nothing is kept", async () => {
    const update = incoming("hello?");
    await parts.router.route(update);
    expect(texts()).toEqual([expect.stringContaining("Nobody is waiting")]);
    expect(sent[0]?.reply_parameters).toEqual({ message_id: update });
    expect(parts.inbox.get(update)).toMatchObject({ state: "unrouted", text: "" });
  });

  test("a repeated update_id is stored and routed once", async () => {
    const waiting = stopAndWait("aaaa1111");
    const update = incoming("once");
    await parts.router.route(update);
    expect(
      parts.relay.accept({
        updateId: update,
        chatId: CHAT,
        messageId: 1,
        replyTo: undefined,
        text: "once",
      }),
    ).toBe(false);
    await parts.router.route(update);
    expect(body(await waiting)).toMatchObject({ text: "once" });
    expect(sent).toEqual([]);
  });
});

describe("the picker's buttons name sessions by title (plan 7.2)", () => {
  test("two of the same title get the start of their id, so each can be told apart", async () => {
    for (const id of ["aaaa1111", "bbbb2222", "cccc3333"]) void stopAndWait(id);
    parts.sessions.retitle("aaaa1111", "Fix the login bug");
    parts.sessions.retitle("bbbb2222", "Fix the login bug");
    parts.sessions.retitle("cccc3333", "Write the README");
    await parts.router.route(incoming("which of you?"));
    const names = buttonRows(sent[0])
      .flat()
      .map((button) => button.text);
    expect(names).toEqual([
      "Fix the login bug · aaaa",
      "Fix the login bug · bbbb",
      "Write the README",
      "Don't send it",
    ]);
  });
});

describe("the picker, with several sessions waiting", () => {
  test("asks which one, with a button each; the chosen one gets it", async () => {
    const first = stopAndWait("aaaa1111");
    void stopAndWait("bbbb2222");
    const update = incoming("which of you?");
    await parts.router.route(update);
    expect(texts()).toEqual([expect.stringContaining("Which one")]);
    const buttons = buttonRows(sent[0])
      .flat()
      .map((button) => button.callback_data);
    expect(buttons).toEqual([`to:${update}:aaaa1111`, `to:${update}:bbbb2222`, `drop:${update}`]);
    await parts.router.press(`to:${update}:aaaa1111`, "q1");
    expect(body(await first)).toMatchObject({ state: "reply", text: "which of you?" });
    expect(answered).toMatchObject([
      { callback_query_id: "q1", text: expect.stringContaining("Sent to") },
    ]);
  });

  test("an answer for an expired request: a second press, or one after 10 minutes, sends nothing", async () => {
    void stopAndWait("aaaa1111");
    void stopAndWait("bbbb2222");
    const update = incoming("which?");
    await parts.router.route(update);
    await parts.router.press(`to:${update}:aaaa1111`, "q1");
    await parts.router.press(`to:${update}:bbbb2222`, "q2");
    expect(answered[1]).toMatchObject({ text: expect.stringContaining("expired") });
    // A stops again, so both wait once more: a second picker.
    void stopAndWait("aaaa1111");
    const late = incoming("and this?");
    await parts.router.route(late);
    expect(texts().at(-1)).toContain("Which one");
    clock += PICK_MS;
    await parts.router.press(`to:${late}:bbbb2222`, "q3");
    expect(answered[2]).toMatchObject({ text: expect.stringContaining("expired") });
    expect(parts.inbox.get(late)).toMatchObject({ state: "unrouted" });
  });

  test("Don't send it: the reply goes nowhere", async () => {
    void stopAndWait("aaaa1111");
    void stopAndWait("bbbb2222");
    const update = incoming("never mind");
    await parts.router.route(update);
    await parts.router.press(`drop:${update}`, "q1");
    expect(parts.inbox.get(update)).toMatchObject({ state: "unrouted", text: "" });
    expect(answered).toMatchObject([{ text: "Not sent." }]);
  });
});

describe("a reply-to one of the bot's notices", () => {
  test("goes to that notice's session, even with another one waiting", async () => {
    void stopAndWait("aaaa1111");
    const second = stopAndWait("bbbb2222");
    parts.outbox.link(CHAT, 77, { sessionId: "bbbb2222", generation: 1, kind: "finish" });
    await parts.router.route(incoming("for B", 77));
    expect(body(await second)).toMatchObject({ state: "reply", text: "for B" });
    expect(sent).toEqual([]);
  });

  test("queued while busy: goes in, with what else was queued, at the session's next stop", async () => {
    busy("aaaa1111");
    parts.outbox.link(CHAT, 77, { sessionId: "aaaa1111", generation: 1, kind: "finish" });
    await parts.router.route(incoming("first", 77));
    await parts.router.route(incoming("second", 77));
    expect(texts()).toEqual([
      expect.stringContaining("is busy"),
      expect.stringContaining("is busy"),
    ]);
    const answer = body(await stopAndWait("aaaa1111"));
    expect(answer).toMatchObject({ state: "reply", text: "first\n\nsecond" });
  });

  test("to an ended session: you're told; a queue it had is lost, and you're told", async () => {
    busy("aaaa1111");
    parts.outbox.link(CHAT, 77, { sessionId: "aaaa1111", generation: 1, kind: "finish" });
    await parts.router.route(incoming("queued", 77));
    parts.sessions.end("aaaa1111");
    parts.relay.ended("aaaa1111");
    await Bun.sleep(1);
    expect(told).toEqual([expect.stringContaining("ended before your queued message")]);
    await parts.router.route(incoming("too late", 77));
    expect(texts().at(-1)).toContain("has ended");
  });
});

test("the outbox forgets notices after a week", () => {
  const db = BrokerDb.open(join(dir, "outbox.db"));
  let now = 0;
  const outbox = new Outbox(db, () => now);
  outbox.link(CHAT, 1, { sessionId: "aaaa1111", generation: 2, kind: "finish" });
  expect(outbox.find(CHAT, 1)).toEqual({ sessionId: "aaaa1111", generation: 2, kind: "finish" });
  expect(outbox.find(CHAT + 1, 1)).toBeUndefined();
  now = 8 * 24 * 60 * 60 * 1000;
  expect(outbox.prune()).toBe(1);
  expect(outbox.find(CHAT, 1)).toBeUndefined();
});
