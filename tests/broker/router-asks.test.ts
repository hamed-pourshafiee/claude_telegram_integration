import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { Inbox } from "../../src/broker/inbox.ts";
import { Outbox } from "../../src/broker/outbox.ts";
import { Relay } from "../../src/broker/relay.ts";
import { Router } from "../../src/broker/router.ts";
import { Waiters } from "../../src/broker/waiters.ts";
import { noLog } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";
import { askHarness, CHAT, FOLDERS } from "../helpers/asks.ts";
import { buttonRows } from "../helpers/buttons.ts";
import { until } from "../helpers/wait.ts";

// Plan 4.1 with flow 4: a reply finds Claude's question, whether it replies to it or is plain.
const dir = mkdtempSync(join(tmpdir(), "tg-router-asks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

const PICK = {
  questions: [{ question: "Which runtime?", options: [{ label: "Bun" }, { label: "Node" }] }],
};
const SLIDES = {
  questions: [{ question: "How many slides?", kind: "number", min: 1, max: 10 }],
};

/** The router and relays of one broker, on one database. */
function build() {
  files += 1;
  const h = askHarness(join(dir, `router-asks-${files}.db`));
  const { db, sessions } = h;
  const waiters = new Waiters(db);
  const inbox = new Inbox(db);
  const tell = () => Promise.resolve();
  const relay = new Relay({
    db,
    sessions,
    waiters,
    inbox,
    tell,
    senderName: () => "Hamed",
    log: noLog,
  });
  const notes: SendMessageParams[] = [];
  const toasts: AnswerCallbackQueryParams[] = [];
  const telegram = {
    sendMessage: (params: SendMessageParams) => {
      notes.push(params);
      return Promise.resolve({ message_id: 900, date: 0, chat: { id: CHAT, type: "private" } });
    },
    answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
      toasts.push(params);
      return Promise.resolve();
    },
  };
  const outbox = new Outbox(db);
  const router = new Router({
    relay,
    waiters,
    asks: h.chat,
    inbox,
    outbox,
    sessions,
    telegram,
    log: noLog,
  });
  let update = 500;
  /** You send `text`, maybe as a reply-to bot message `replyTo`: its update id, once stored. */
  const incoming = (text: string, replyTo?: number) => {
    update += 1;
    relay.accept({ updateId: update, chatId: CHAT, messageId: update, replyTo, text });
    return update;
  };
  /** Another session stops, and its hook waits for a reply. */
  const otherWaits = () => {
    sessions.touch({ id: "0253aaaa", projectDir: FOLDERS.sandbox, entrypoint: "cli" });
    const generation = sessions.stop("0253aaaa");
    return Promise.resolve(
      relay.wait({ session_id: "0253aaaa", generation, pid: 1, claude_pid: 1 }),
    );
  };
  return { h, inbox, router, notes, toasts, incoming, otherWaits };
}

const body = (answer: Answer) => answer.body as Record<string, unknown>;

async function asked(parts: ReturnType<typeof build>, input: unknown) {
  const waiting = parts.h.ask("toolu_1", input);
  expect(await until(() => parts.h.posted.length === 1)).toBe(true);
  // In an object: an async function returning the promise itself would wait for its answer.
  return { waiting };
}

describe("replies to Claude's questions", () => {
  test("a reply-to a question's message answers it; its text is dropped once used", async () => {
    const parts = build();
    const { waiting } = await asked(parts, PICK);
    const update = parts.incoming("Deno, please", 101);
    await parts.router.route(update);
    expect(body(await waiting)).toMatchObject({ answers: { "Which runtime?": "Deno, please" } });
    expect(parts.inbox.get(update)).toMatchObject({ state: "delivered", text: "" });
    expect(parts.notes).toEqual([]);
  });

  test("a reply-to the second question answers that one, while the first is still open", async () => {
    const parts = build();
    const two = { questions: [...PICK.questions, ...SLIDES.questions] };
    const waiting = parts.h.ask("toolu_1", two);
    expect(await until(() => parts.h.posted.length === 2)).toBe(true);
    await parts.router.route(parts.incoming("7", 102));
    const id = parts.h.idOf("toolu_1");
    expect(parts.h.asks.questions(id).map((question) => question.answer)).toEqual([undefined, "7"]);
    await parts.router.route(parts.incoming("Bun", 101));
    expect(body(await waiting)).toMatchObject({
      answers: { "Which runtime?": "Bun", "How many slides?": "7" },
    });
  });

  test("a plain message goes to the only session asking", async () => {
    const parts = build();
    const { waiting } = await asked(parts, PICK);
    await parts.router.route(parts.incoming("Node"));
    expect(body(await waiting)).toMatchObject({ answers: { "Which runtime?": "Node" } });
  });

  test("one session asks, another waits: the picker lists both; the asking one takes it as its answer", async () => {
    const parts = build();
    const { waiting } = await asked(parts, PICK);
    const other = parts.otherWaits();
    const update = parts.incoming("Bun");
    await parts.router.route(update);
    const rows = buttonRows(parts.notes[0]);
    expect(rows.map((row) => row[0]?.callback_data)).toEqual([
      `to:${update}:0253aaaa`,
      `to:${update}:5e551011-aaaa`,
      `drop:${update}`,
    ]);
    await parts.router.press(`to:${update}:5e551011-aaaa`, "pick");
    expect(body(await waiting)).toMatchObject({ answers: { "Which runtime?": "Bun" } });
    expect(parts.toasts).toEqual([{ callback_query_id: "pick", text: "Sent to sandbox · 5e55." }]);
    let otherDone = false;
    void other.then(() => (otherDone = true));
    await Bun.sleep(20);
    expect(otherDone).toBe(false);
  });
});

describe("replies a question can't take", () => {
  test("a number out of range is asked for again, in the thread of your reply", async () => {
    const parts = build();
    await asked(parts, SLIDES);
    const update = parts.incoming("99", 101);
    await parts.router.route(update);
    expect(parts.notes).toEqual([
      {
        chat_id: CHAT,
        reply_parameters: { message_id: update },
        text: "Please send a number from 1 to 10.",
      },
    ]);
    expect(parts.inbox.get(update)).toMatchObject({ state: "unrouted", text: "" });
  });

  test("a reply-to a question that has left the chat isn't used", async () => {
    const parts = build();
    const { waiting } = await asked(parts, PICK);
    parts.h.chat.handBack();
    await waiting;
    await parts.router.route(parts.incoming("Bun", 101));
    expect(parts.notes.map((note) => note.text)).toEqual([
      "That question is no longer open, so this wasn't used.",
    ]);
  });
});
