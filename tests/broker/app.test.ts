import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/broker/app.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { Pairing } from "../../src/broker/pairing.ts";
import { pairingInstructions } from "../../src/ctl/pair.ts";
import { asFields } from "../../src/shared/json.ts";
import { noLog } from "../../src/shared/log.ts";
import { Secret } from "../../src/shared/secret.ts";
import { FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";
import { until } from "../helpers/wait.ts";

// The broker's parts together, in this process, against a fake Bot API: plan 2.4 end to end.
const fake = new FakeTelegram();
const dir = mkdtempSync(join(tmpdir(), "tg-app-"));
let controller = new AbortController();
let files = 0;
afterAll(() => {
  controller.abort();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  controller.abort();
  controller = new AbortController();
  fake.reset();
  // Like long polling: an empty answer after a short wait.
  fake.fallback("getUpdates", { json: { ok: true, result: [] }, delayMs: 30 });
});

function app(db?: BrokerDb) {
  files += 1;
  const opened = db ?? BrokerDb.open(join(dir, `app-${files}.db`));
  const deps = { token: new Secret(FAKE_TOKEN), db: opened, log: noLog, signal: controller.signal };
  return { db: opened, ...createApp({ ...deps, apiBase: fake.url }) };
}

const you = { id: 4242, is_bot: false, first_name: "Hamed", username: "hamed" };

test("before any pairing the broker doesn't poll Telegram at all", async () => {
  const { routes, poller } = app();
  await Bun.sleep(100);
  expect(poller.running).toBe(false);
  expect(fake.calls("getUpdates")).toEqual([]);
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
});

test("once paired, a restarted broker polls at once", async () => {
  const db = BrokerDb.open(join(dir, "paired.db"));
  const pairing = new Pairing(db);
  pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
  const { poller } = app(db);
  expect(poller.running).toBe(true);
  expect(await until(() => fake.calls("getUpdates").length > 0)).toBe(true);
});

test("ctl pair shows the code and what to send", () => {
  const text = pairingInstructions("K7QX-M4PD", "2026-09-28T10:05:00.000Z");
  expect(text).toContain("Pairing code: K7QX-M4PD");
  expect(text).toContain("    /pair K7QX-M4PD");
  expect(text).toMatch(/valid until \d\d:\d\d/);
});
