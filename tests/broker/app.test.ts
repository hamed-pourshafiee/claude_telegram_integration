import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/broker/app.ts";
import { MENU } from "../../src/broker/commands.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import type { Reading } from "../../src/broker/ioreg.ts";
import { Pairing } from "../../src/broker/pairing.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { pairingInstructions } from "../../src/ctl/pair.ts";
import { parseConfig } from "../../src/shared/config.ts";
import { asFields } from "../../src/shared/json.ts";
import { noLog } from "../../src/shared/log.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { Secret } from "../../src/shared/secret.ts";
import { FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";
import { until } from "../helpers/wait.ts";

// The broker's parts together, in this process, against a fake Bot API: plan 2.4 end to end.
const fake = new FakeTelegram();
const dir = mkdtempSync(join(tmpdir(), "tg-app-"));
let controller = new AbortController();
let files = 0;
/** What the stand-in Mac shows. */
let mac: Reading = { idleSeconds: 1, locked: false, problems: [] };
afterAll(() => {
  controller.abort();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  controller.abort();
  controller = new AbortController();
  mac = { idleSeconds: 1, locked: false, problems: [] };
  fake.reset();
  // Like long polling: an empty answer after a short wait.
  fake.fallback("getUpdates", { json: { ok: true, result: [] }, delayMs: 30 });
  fake.fallback("setMyCommands", ok(true));
});

/** The menu of commands, for the paired chat only (plan 7.1). */
const menuFor = (chatId: number) => ({ commands: MENU, scope: { type: "chat", chat_id: chatId } });

function app(db?: BrokerDb) {
  files += 1;
  const opened = db ?? BrokerDb.open(join(dir, `app-${files}.db`));
  const deps = { token: new Secret(FAKE_TOKEN), db: opened, log: noLog, signal: controller.signal };
  const config = parseConfig({}, { repoRoot: dir, home: dir });
  const readPresence = () => Promise.resolve(mac);
  const paths = statePaths(join(dir, `state-${files}`));
  return { db: opened, ...createApp({ ...deps, config, paths, readPresence, apiBase: fake.url }) };
}

const you = { id: 4242, is_bot: false, first_name: "Hamed", username: "hamed" };

test("before any pairing the broker doesn't poll Telegram at all", async () => {
  const { routes, poller } = app();
  await Bun.sleep(100);
  expect(poller.running).toBe(false);
  expect(fake.calls("getUpdates")).toEqual([]);
  expect(fake.calls("setMyCommands")).toEqual([]);
  expect(asFields(routes.health())).toMatchObject({
    paired: null,
    pairingUntil: null,
    polling: false,
  });
});

test("ctl pair's route starts polling, and '/pair <code>' from the bot chat pairs you", async () => {
  const { routes } = app();
  const answer = asFields(routes.pair());
  const code = String(answer?.code);
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(asFields(routes.health())).toMatchObject({ polling: true, paired: null });
  const chat = { id: you.id, type: "private" };
  const pair = { message_id: 1, date: 0, chat, from: you, text: `/pair ${code}` };
  fake.answer("getUpdates", ok([{ update_id: 500, message: pair }]));
  fake.answer("sendMessage", ok({ message_id: 2, date: 0, chat, text: "Paired ✅" }));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  expect(fake.calls("sendMessage")[0]?.body).toMatchObject({
    chat_id: you.id,
    text: expect.stringMatching(/^Paired ✅/),
  });
  expect(asFields(routes.health())).toMatchObject({ paired: "Hamed (@hamed)", pairingUntil: null });
  expect(await until(() => fake.calls("setMyCommands").length === 1)).toBe(true);
  expect(fake.calls("setMyCommands")[0]?.body).toEqual(menuFor(you.id));
});

test("once paired, a restarted broker polls at once", async () => {
  const db = BrokerDb.open(join(dir, "paired.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
  const { poller } = app(db);
  expect(poller.running).toBe(true);
  expect(await until(() => fake.calls("getUpdates").length > 0)).toBe(true);
  // Its chat's menu, again at every start (plan 7.1).
  expect(fake.calls("setMyCommands").map((call) => call.body)).toEqual([menuFor(you.id)]);
});

test("/status from the paired user gets where the Mac says you are (plan 2.6)", async () => {
  mac = { idleSeconds: 3, locked: true, problems: [] };
  const db = BrokerDb.open(join(dir, "status.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
  const { routes, presence } = app(db);
  expect(await until(() => presence.snapshot().because === "locked")).toBe(true);
  const chat = { id: you.id, type: "private" };
  const status = { message_id: 3, date: 0, chat, from: you, text: "/status" };
  fake.answer("getUpdates", ok([{ update_id: 600, message: status }]));
  fake.answer("sendMessage", ok({ message_id: 4, date: 0, chat, text: "🔴 Away" }));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  expect(fake.calls("sendMessage")[0]?.body).toMatchObject({
    chat_id: you.id,
    text: expect.stringMatching(/^🔴 Away: the screen is locked\n/),
  });
  expect(asFields(routes.health())?.presence).toEqual({
    mode: "auto",
    state: "away",
    because: "locked",
    idleSeconds: 3,
    locked: true,
  });
});

test("a finished turn while you're away: the ✅ arrives, and 📄 sends the whole reply (plan 2.7)", async () => {
  mac = { idleSeconds: 400, locked: false, problems: [] };
  const db = BrokerDb.open(join(dir, "notify.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed (@hamed)" });
  const { routes, presence } = app(db);
  expect(await until(() => presence.snapshot().state === "away")).toBe(true);
  mkdirSync(join(dir, "sandbox"), { recursive: true });
  const ref = { session_id: "b1e81638", project_dir: join(dir, "sandbox"), entrypoint: "cli" };
  const generation = asFields((await routes.hook("Stop", ref)).body)?.generation;
  const chat = { id: you.id, type: "private" };
  fake.fallback("sendMessage", ok({ message_id: 11, date: 0, chat, text: "✅" }));
  const reply = `${"word ".repeat(1000)}END`;
  routes.hook("StopResult", { ...ref, generation, outcome: "finish", text: reply, tasks: [] });
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const sent = asFields(fake.calls("sendMessage")[0]?.body);
  expect(String(sent?.text)).toStartWith("<b>✅ sandbox · b1e8</b>");
  expect(String(sent?.text)).not.toContain("END");
  const keyboard = asFields(sent?.reply_markup)?.inline_keyboard;
  const data = Array.isArray(keyboard) ? asFields(keyboard[0]?.[0])?.callback_data : undefined;
  const press = { id: "cbq1", from: you, data, message: { message_id: 11, chat } };
  fake.answer("getUpdates", ok([{ update_id: 700, callback_query: press }]));
  fake.answer("answerCallbackQuery", ok(true));
  fake.answer("sendDocument", ok({ message_id: 12, date: 0, chat }));
  expect(await until(() => fake.calls("sendDocument").length === 1)).toBe(true);
  const file = asFields(asFields(fake.calls("sendDocument")[0]?.body)?.document);
  expect(String(file?.content)).toEndWith("END");
});

test("your reply-to a ✅ reaches that session: queued while it's busy, then its next Wait (plan 3.2)", async () => {
  mac = { idleSeconds: 400, locked: false, problems: [] };
  const db = BrokerDb.open(join(dir, "reply.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed (@hamed)" });
  const { routes, presence } = app(db);
  expect(await until(() => presence.snapshot().state === "away")).toBe(true);
  mkdirSync(join(dir, "sandbox"), { recursive: true });
  const ref = { session_id: "c0ffee00", project_dir: join(dir, "sandbox"), entrypoint: "cli" };
  const generation = asFields((await routes.hook("Stop", ref)).body)?.generation;
  const chat = { id: you.id, type: "private" };
  fake.fallback("sendMessage", ok({ message_id: 21, date: 0, chat, text: "sent" }));
  await routes.hook("StopResult", {
    ...ref,
    generation,
    outcome: "finish",
    text: "Done.",
    tasks: [],
  });
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  // You reply to the ✅ (message 21) before the hook waits: the session counts as busy.
  const message = { message_id: 30, date: 0, chat, from: you, text: "now say bye" };
  const replyTo = { ...message, reply_to_message: { message_id: 21, date: 0, chat } };
  fake.answer("getUpdates", ok([{ update_id: 800, message: replyTo }]));
  expect(await until(() => fake.calls("sendMessage").length === 2)).toBe(true);
  expect(String(asFields(fake.calls("sendMessage")[1]?.body)?.text)).toContain("is busy");
  const wait = { ...ref, generation, pid: process.pid, claude_pid: process.pid };
  const answer = asFields((await routes.hook("Wait", wait)).body);
  expect(answer).toMatchObject({ state: "reply", text: "now say bye", from: "Hamed" });
});

test("Claude asks while you're away: the ❓ arrives with buttons, and your tap is the answer (plan 4.1)", async () => {
  mac = { idleSeconds: 400, locked: false, problems: [] };
  const db = BrokerDb.open(join(dir, "ask.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed (@hamed)" });
  const { routes, presence } = app(db);
  expect(await until(() => presence.snapshot().state === "away")).toBe(true);
  mkdirSync(join(dir, "sandbox"), { recursive: true });
  const ref = { session_id: "a5a5a5a5", project_dir: join(dir, "sandbox"), entrypoint: "cli" };
  const chat = { id: you.id, type: "private" };
  fake.fallback("sendMessage", ok({ message_id: 41, date: 0, chat, text: "❓" }));
  fake.fallback("editMessageText", ok({ message_id: 41, date: 0, chat, text: "✅" }));
  const options = [{ label: "Red" }, { label: "Blue" }];
  const input = { questions: [{ question: "Which color?", header: "Color", options }] };
  const call = { ...ref, tool_use_id: "toolu_9", input, pid: process.pid, claude_pid: process.pid };
  const asked = Promise.resolve(routes.hook("Ask", call));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const sent = asFields(fake.calls("sendMessage")[0]?.body);
  expect(String(sent?.text)).toStartWith("<b>❓ sandbox · a5a5 asks</b>");
  const keyboard = asFields(sent?.reply_markup)?.inline_keyboard;
  const blue = Array.isArray(keyboard) ? asFields(keyboard[1]?.[0])?.callback_data : undefined;
  const press = { id: "cbq9", from: you, data: blue, message: { message_id: 41, chat } };
  fake.answer("answerCallbackQuery", ok(true));
  fake.answer("getUpdates", ok([{ update_id: 900, callback_query: press }]));
  expect(asFields((await asked).body)).toMatchObject({
    state: "answered",
    answers: { "Which color?": "Blue" },
  });
  expect(asFields((await routes.hook("AskConfirm", call)).body)).toMatchObject({ delivered: true });
  expect(await until(() => fake.calls("editMessageText").length === 1)).toBe(true);
  expect(String(asFields(fake.calls("editMessageText")[0]?.body)?.text)).toEndWith("✅ Blue");
});

test("ctl pair shows the code and what to send", () => {
  const text = pairingInstructions("K7QX-M4PD", "2026-09-28T10:05:00.000Z");
  expect(text).toContain("Pairing code: K7QX-M4PD");
  expect(text).toContain("    /pair K7QX-M4PD");
  expect(text).toMatch(/valid until \d\d:\d\d/);
});

test("at start, titles of sessions whose folder no longer shows text go (D8, plan 7.2)", () => {
  const db = BrokerDb.open(join(dir, "titles.db"));
  const sessions = new Sessions(db);
  // The config serves this repo's sandbox/ with its text; a folder that isn't there is ping-only.
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  sessions.touch({ id: "kept", projectDir: sandbox, entrypoint: "cli", title: "Sandbox work" });
  sessions.touch({
    id: "gone",
    projectDir: join(dir, "moved"),
    entrypoint: "cli",
    title: "Old work",
  });
  app(db);
  expect(sessions.get("kept")?.title).toBe("Sandbox work");
  expect(sessions.get("gone")?.title).toBe("");
});

test("/sessions lists the sessions whose Claude runs, and what each is doing (plan 7.3)", async () => {
  const db = BrokerDb.open(join(dir, "sessions.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
  const { routes } = app(db);
  mkdirSync(join(dir, "sandbox"), { recursive: true });
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const live = {
    session_id: "a11ce000",
    project_dir: join(dir, "sandbox"),
    entrypoint: "cli",
    title: "Fix the login bug",
    claude_pid: process.pid,
  };
  await routes.hook("SessionStart", { ...live, session_id: "c0a5ed00", claude_pid: exited.pid });
  await routes.hook("UserPromptSubmit", { ...live, at: Date.now() });
  const chat = { id: you.id, type: "private" };
  const command = { message_id: 40, date: 0, chat, from: you, text: "/sessions" };
  fake.answer("getUpdates", ok([{ update_id: 900, message: command }]));
  fake.answer("sendMessage", ok({ message_id: 41, date: 0, chat, text: "1 open session" }));
  expect(await until(() => fake.calls("sendMessage").length === 1)).toBe(true);
  const text = String(asFields(fake.calls("sendMessage")[0]?.body)?.text);
  expect(text).toMatch(/^1 open session:\n⏳ Fix the login bug: working for \d+ s$/);
});
