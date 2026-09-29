import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { backoffMs, offsetKey, Poller } from "../../src/broker/poller.ts";
import type { Log } from "../../src/shared/log.ts";
import { Secret } from "../../src/shared/secret.ts";
import { TelegramClient } from "../../src/shared/telegram/client.ts";
import { TelegramError } from "../../src/shared/telegram/errors.ts";
import type { Update } from "../../src/shared/telegram/types.ts";
import { apiError, FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";
import { until } from "../helpers/wait.ts";

const fake = new FakeTelegram();
const dir = mkdtempSync(join(tmpdir(), "tg-poller-"));
afterAll(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

let handled: number[] = [];
let sleeps: number[] = [];
let logged: string[] = [];
let controller = new AbortController();
let db: BrokerDb;
let files = 0;
beforeEach(() => {
  controller.abort();
  controller = new AbortController();
  fake.reset();
  fake.fallback("getUpdates", { hang: true });
  handled = [];
  sleeps = [];
  logged = [];
  files += 1;
  db = BrokerDb.open(join(dir, `poller-${files}.db`));
});

const log: Log = (event, fields) => logged.push(JSON.stringify({ event, ...fields }));
/** The bot id in FAKE_TOKEN. */
const BOT_ID = 7777777777;
const text = (update_id: number) => ({
  update_id,
  message: { message_id: update_id, date: 0, chat: { id: 1, type: "private" }, text: "hi" },
});

function poller(
  handle: (update: Update) => Promise<void> = async (u) => void handled.push(u.update_id),
  accept: (update: Update) => void = () => undefined,
) {
  const { signal } = controller;
  const telegram = new TelegramClient({ token: new Secret(FAKE_TOKEN), apiBase: fake.url, signal });
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  const deps = { telegram, db, log, accept, handle, signal, sleep };
  return new Poller({ ...deps, botId: BOT_ID, pollSeconds: 1 });
}

describe("the poller", () => {
  test("hands updates over in order, records the offset after each, and asks from there", async () => {
    fake.answer("getUpdates", ok([text(10), text(11)]));
    poller().start();
    expect(await until(() => fake.calls("getUpdates").length === 2)).toBe(true);
    expect(handled).toEqual([10, 11]);
    expect(db.getMeta(offsetKey(BOT_ID))).toBe("12");
    expect(fake.calls("getUpdates")[1]?.body).toMatchObject({ offset: 12, timeout: 1 });
  });

  test("starts from the stored offset, so a restart carries on after the last update", async () => {
    db.setMeta(offsetKey(BOT_ID), "42");
    poller().start();
    expect(await until(() => fake.calls("getUpdates").length === 1)).toBe(true);
    expect(fake.calls("getUpdates")[0]?.body).toMatchObject({ offset: 42 });
  });

  test("an update whose handling fails is logged and passed, never retried", async () => {
    fake.answer("getUpdates", ok([text(20), text(21)]));
    const handle = async (update: Update) => {
      if (update.update_id === 20) throw new Error("boom");
      handled.push(update.update_id);
    };
    poller(handle).start();
    expect(await until(() => handled.length === 1)).toBe(true);
    expect(db.getMeta(offsetKey(BOT_ID))).toBe("22");
    expect(logged.some((line) => line.includes('"event":"update.failed"'))).toBe(true);
  });
});

describe("storing replies before the offset moves on (plan 3.1, D7)", () => {
  test("a reply is stored before the offset moves on, and handled after", async () => {
    fake.answer("getUpdates", ok([text(50)]));
    const offsets: (string | undefined)[] = [];
    const accept = () => void offsets.push(db.getMeta(offsetKey(BOT_ID)));
    const handle = async (update: Update) => {
      offsets.push(db.getMeta(offsetKey(BOT_ID)));
      handled.push(update.update_id);
    };
    poller(handle, accept).start();
    expect(await until(() => handled.length === 1)).toBe(true);
    expect(offsets).toEqual([undefined, "51"]);
  });

  test("a crash after fetching, before storing: the offset stays, and the update comes again", async () => {
    fake.answer("getUpdates", ok([text(60)]), ok([text(60)]));
    let fails = 1;
    const stored: number[] = [];
    const accept = (update: Update) => {
      if (fails-- > 0) throw new Error("disk full");
      stored.push(update.update_id);
    };
    poller(undefined, accept).start();
    expect(await until(() => handled.length === 1)).toBe(true);
    expect(stored).toEqual([60]);
    expect(fake.calls("getUpdates")[1]?.body).not.toHaveProperty("offset");
    expect(db.getMeta(offsetKey(BOT_ID))).toBe("61");
    expect(sleeps).toEqual([1000]);
  });
});

describe("the poller, failing and stopping", () => {
  test("failures wait: a 409 60 s, a 401 5 minutes, then it carries on", async () => {
    fake.answer(
      "getUpdates",
      apiError(409, "Conflict"),
      apiError(401, "Unauthorized"),
      ok([text(30)]),
    );
    poller().start();
    expect(await until(() => handled.length === 1)).toBe(true);
    expect(sleeps).toEqual([60_000, 300_000]);
  });

  test("stops when its signal aborts, even in the middle of a long poll", async () => {
    const running = poller();
    running.start();
    expect(await until(() => fake.calls("getUpdates").length === 1)).toBe(true);
    expect(running.running).toBe(true);
    controller.abort();
    expect(await until(() => !running.running)).toBe(true);
  });
});

test("the offset belongs to its bot: another bot starts afresh, the same bot carries on (Codex review of 2.4)", async () => {
  const run = async (token: string, botId: number) => {
    const signal = controller.signal;
    const telegram = new TelegramClient({ token: new Secret(token), apiBase: fake.url, signal });
    const handle = async (update: Update) => void handled.push(update.update_id);
    const accept = () => undefined;
    new Poller({ telegram, db, log, accept, handle, signal, botId, pollSeconds: 1 }).start();
    const before = fake.calls("getUpdates").length;
    expect(await until(() => fake.calls("getUpdates").length > before)).toBe(true);
    controller.abort();
    controller = new AbortController();
    return fake.calls("getUpdates").at(-1)?.body;
  };
  fake.answer("getUpdates", ok([text(899)]));
  const botA = `1234567:${"A".repeat(35)}`;
  await run(botA, 1234567);
  expect(handled).toEqual([899]);
  expect(await run(FAKE_TOKEN, 7777777777)).not.toHaveProperty("offset");
  expect(await run(`1234567:${"B".repeat(35)}`, 1234567)).toMatchObject({ offset: 900 });
});

test("backoffMs: 1 s doubling to 60 s; 409, 401 and 429 by their own rules", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 9].map((n) => backoffMs(new Error("x"), n))).toEqual([
    1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
  ]);
  expect(backoffMs(new TelegramError("m", "getUpdates", "api", 409), 1)).toBe(60_000);
  expect(backoffMs(new TelegramError("m", "getUpdates", "api", 401), 1)).toBe(300_000);
  expect(backoffMs(new TelegramError("m", "getUpdates", "flood", 429, 7), 1)).toBe(7000);
});
