import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Pairing } from "../../src/broker/pairing.ts";
import { asFields } from "../../src/shared/json.ts";
import { appHarness, YOU } from "../helpers/app.ts";
import { ok } from "../helpers/fake-telegram.ts";
import { until } from "../helpers/wait.ts";

// Plans 7.3 and 7.4 end to end: /sessions from the chat, and a tap on one of its sessions to write to it.
const harness = appHarness("app-sessions");
const { fake, dir, app } = harness;
const chat = { id: YOU.id, type: "private" };
let updates = 900;

/** The broker, paired, with a session of this test's process as its Claude. */
function paired(name: string) {
  const db = BrokerDb.open(join(dir, `${name}.db`));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: YOU.id, name: "Hamed" });
  mkdirSync(join(dir, "sandbox"), { recursive: true });
  const session = {
    session_id: "a11ce000",
    project_dir: join(dir, "sandbox"),
    entrypoint: "cli",
    title: "Fix the login bug",
    claude_pid: process.pid,
  };
  return { ...app(db), session };
}

/** What the paired user sends next, as the poller gets it. */
function from(you: object) {
  updates += 1;
  fake.answer("getUpdates", ok([{ update_id: updates, ...you }]));
}

const message = (id: number, text: string, extra: object = {}) => ({
  message: { message_id: id, date: 0, chat, from: YOU, text, ...extra },
});

test("/sessions lists the sessions whose Claude runs, and what each is doing (plan 7.3)", async () => {
  const { routes, session } = paired("listed");
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  await routes.hook("SessionStart", { ...session, session_id: "c0a5ed00", claude_pid: exited.pid });
  await routes.hook("UserPromptSubmit", { ...session, at: Date.now() });
  fake.answer("sendMessage", ok({ message_id: 41, date: 0, chat, text: "1 open session" }));
  from(message(40, "/sessions"));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const text = String(asFields(fake.calls("sendMessage")[0]?.body)?.text);
  expect(text).toMatch(
    /^1 open session:\n⏳ Fix the login bug: working for \d+ s\n\nTap one to write to it\.$/,
  );
});

test("a tap on a session opens the reply box, and what you send goes to it (plan 7.4)", async () => {
  const { routes, session } = paired("written");
  const generation = asFields((await routes.hook("Stop", session)).body)?.generation;
  const waiting = { ...session, generation, pid: process.pid };
  const reply = routes.hook("Wait", waiting);
  fake.answer("sendMessage", ok({ message_id: 41, date: 0, chat, text: "list" }));
  fake.answer("sendMessage", ok({ message_id: 42, date: 0, chat, text: "✏️" }));
  fake.fallback("answerCallbackQuery", ok(true));
  from(message(40, "/sessions"));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const markup = asFields(asFields(fake.calls("sendMessage")[0]?.body)?.reply_markup);
  expect(markup?.inline_keyboard).toEqual([
    [{ text: "✅ Fix the login bug", callback_data: "write:a11ce000" }],
  ]);
  const press = {
    id: "cbq1",
    from: YOU,
    data: "write:a11ce000",
    message: { message_id: 41, chat },
  };
  from({ callback_query: press });
  expect(await until(() => fake.calls("sendMessage").length === 2)).toBe(true);
  expect(fake.calls("sendMessage")[1]?.body).toMatchObject({
    text: expect.stringMatching(/^✏️ Your message for ✅ Fix the login bug\n/),
    reply_markup: { force_reply: true },
  });
  // Telegram's reply box makes what you type a reply to the bot's question.
  from(message(43, "run the tests", { reply_to_message: { message_id: 42, date: 0, chat } }));
  expect(asFields((await reply).body)).toMatchObject({
    state: "reply",
    text: "run the tests",
    from: "Hamed",
  });
});
