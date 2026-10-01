import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Pairing } from "../../src/broker/pairing.ts";
import type { VsWindow } from "../../src/broker/vscode-windows.ts";
import { asFields } from "../../src/shared/json.ts";
import { appHarness, YOU } from "../helpers/app.ts";
import { ok } from "../helpers/fake-telegram.ts";
import { until } from "../helpers/wait.ts";

// Plans 7.3 to 7.5 and 7.7 end to end: /sessions from the chat, with each session's title as it is
// now, a tap on one of its sessions to write to it, and /new.
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

/** The first button of the bot's message number `at`, counted from 0. */
function firstButton(at: number) {
  const markup = asFields(asFields(fake.calls("sendMessage")[at]?.body)?.reply_markup);
  const rows = markup?.inline_keyboard;
  return Array.isArray(rows) ? asFields(rows[0]?.[0]) : undefined;
}

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

test("a title Claude Code made after the session's last hook is in /sessions (plan 7.5)", async () => {
  const { routes, session } = paired("titled");
  const transcript = join(dir, "93c4408c.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", message: { content: "IQ-1572" } })}\n`,
  );
  const untitled = { ...session, title: undefined, transcript };
  await routes.hook("SessionStart", untitled);
  await routes.hook("UserPromptSubmit", { ...untitled, at: Date.now() });
  // A second later, during the first turn, when no hook of the session runs (F21).
  appendFileSync(transcript, `${JSON.stringify({ type: "ai-title", aiTitle: "IQ-1572" })}\n`);
  fake.answer("sendMessage", ok({ message_id: 61, date: 0, chat, text: "1 open session" }));
  from(message(60, "/sessions"));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const text = String(asFields(fake.calls("sendMessage")[0]?.body)?.text);
  expect(text).toMatch(/^1 open session:\n⏳ IQ-1572: working for \d+ s\n/);
});

test("/new: a tap on a window and a reply open a tab there, whose SessionStart gets the message (plans 7.7, 7.8)", async () => {
  const tabs: VsWindow[] = [];
  const openTab = (window: VsWindow) => {
    tabs.push(window);
    return Promise.resolve();
  };
  mkdirSync(join(dir, "sandbox", "api"), { recursive: true });
  const sandbox = realpathSync(join(dir, "sandbox"));
  const opened = join(dir, "studio.code-workspace");
  const studio = { name: "studio", folder: sandbox, addDirs: [join(sandbox, "api")], opened };
  const db = BrokerDb.open(join(dir, "new.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: YOU.id, name: "Hamed" });
  const { routes } = app(db, { openTab, openWindows: () => [studio] });
  fake.answer("sendMessage", ok({ message_id: 71, date: 0, chat, text: "windows" }));
  fake.answer("sendMessage", ok({ message_id: 72, date: 0, chat, text: "✏️" }));
  fake.fallback("sendMessage", ok({ message_id: 73, date: 0, chat, text: "🖥" }));
  fake.fallback("answerCallbackQuery", ok(true));
  from(message(70, "/new"));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const button = firstButton(0);
  expect(button?.text).toBe("🖥 studio");
  const tap = {
    id: "cbq2",
    from: YOU,
    data: button?.callback_data,
    message: { message_id: 71, chat },
  };
  from({ callback_query: tap });
  expect(await until(() => fake.calls("sendMessage").length === 2)).toBe(true);
  from(message(74, "Fix the tests", { reply_to_message: { message_id: 72, date: 0, chat } }));
  expect(await until(() => tabs.length === 1)).toBe(true);
  expect(tabs[0]).toEqual(studio);
  expect(await until(() => fake.calls("sendMessage").length === 3)).toBe(true);
  const note = String(asFields(fake.calls("sendMessage")[2]?.body)?.text);
  expect(note).toStartWith("🖥 Opening a new Claude tab in studio.");
  // The new tab's SessionStart hook, as it calls the broker.
  const tab = { project_dir: sandbox, entrypoint: "claude-vscode", claude_pid: process.pid };
  const answer = await routes.hook("SessionStart", {
    ...tab,
    session_id: "7ab0c0de",
    branch: "",
    source: "startup",
  });
  expect(answer.body).toMatchObject({
    name: "Hamed",
    first: "📨 From Hamed on Telegram: Fix the tests",
  });
  const again = await routes.hook("SessionStart", {
    ...tab,
    session_id: "5ec0d7ab",
    source: "startup",
  });
  expect(again.body).not.toHaveProperty("first");
});
