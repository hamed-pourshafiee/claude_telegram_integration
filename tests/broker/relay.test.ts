import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { Inbox } from "../../src/broker/inbox.ts";
import { Outbox } from "../../src/broker/outbox.ts";
import { Relay } from "../../src/broker/relay.ts";
import { Router } from "../../src/broker/router.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { type Waiter, Waiters } from "../../src/broker/waiters.ts";
import { noLog } from "../../src/shared/log.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { writePending } from "../../src/shared/pending.ts";
import type { SendMessageParams } from "../../src/shared/telegram/types.ts";
import { noAskChat } from "../helpers/no-asks.ts";

// Plan 3.1: the waiter protocol through the relay (flows 1, 2 and 4). A "restart" is a new relay on the
// same database, as a broker that crashed and came back.
const root = mkdtempSync(join(tmpdir(), "tg-relay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let runs = 0;
let file: string;
let paths: ReturnType<typeof statePaths>;
let told: string[];
let dead: Set<number>;
beforeEach(() => {
  runs += 1;
  file = join(root, `relay-${runs}.db`);
  paths = statePaths(join(root, `state-${runs}`));
  told = [];
  dead = new Set();
});

const ID = "b1e81638";
const HOOK = { pid: 5001, claude_pid: 5000 };

/** A broker's relay and router on this test's database; call it again for a restarted broker. */
function broker(onCancelled?: (waiter: Waiter) => void) {
  const db = BrokerDb.open(file);
  const sessions = new Sessions(db);
  const waiters = new Waiters(db);
  const inbox = new Inbox(db);
  const say = (text: string) => {
    told.push(text);
    return Promise.resolve();
  };
  const relay = new Relay({
    db,
    sessions,
    waiters,
    inbox,
    tell: say,
    senderName: () => "Hamed",
    log: noLog,
    holdMs: 60_000,
    alive: (pid) => !dead.has(pid),
    ...(onCancelled === undefined ? {} : { onCancelled }),
  });
  const telegram = {
    sendMessage: async (params: SendMessageParams) => {
      await say(params.text);
      return { message_id: 1, date: 0, chat: { id: params.chat_id, type: "private" } };
    },
    answerCallbackQuery: () => Promise.resolve(),
  };
  const parts = { relay, waiters, asks: noAskChat, inbox, outbox: new Outbox(db), sessions };
  const router = new Router({ ...parts, telegram, log: noLog });
  const touch = () => sessions.touch({ id: ID, projectDir: "/work/sandbox", entrypoint: "cli" });
  const stop = () => {
    touch();
    const generation = sessions.stop(ID);
    relay.stopped(ID, generation);
    return generation;
  };
  const wait = (generation: number) =>
    Promise.resolve(relay.wait({ session_id: ID, generation, ...HOOK }));
  let update = 100;
  const reply = (text = "now say bye") => {
    update += 1;
    relay.accept({ updateId: update, chatId: 42, messageId: update, replyTo: undefined, text });
    return update;
  };
  const route = (updateId: number) => router.route(updateId);
  const recover = () => {
    relay.recover(paths);
    return router.recover();
  };
  return { db, sessions, relay, stop, wait, reply, route, recover };
}

const body = (answer: Answer) => answer.body as Record<string, unknown>;
const tick = () => Bun.sleep(1);

describe("a reply and typing at the Mac race (flow 2)", () => {
  test("reply first: the waiter gets it, confirms it; your typing then crosses it", async () => {
    const { relay, stop, wait, reply, route } = broker();
    const generation = stop();
    const parked = wait(generation);
    const update = reply();
    await route(update);
    expect(body(await parked)).toMatchObject({
      state: "reply",
      text: "now say bye",
      from: "Hamed",
    });
    relay.cancel(ID, Date.now());
    await tick();
    expect(told).toEqual([expect.stringContaining("crossed with typing")]);
    const confirm = relay.confirm({ session_id: ID, generation, update_id: update });
    expect(body(confirm)).toMatchObject({ delivered: true });
  });

  test("typed first: the waiter is cancelled, and the reply goes nowhere", async () => {
    const { relay, stop, wait, reply, route } = broker();
    const parked = wait(stop());
    await tick();
    relay.cancel(ID, Date.now());
    expect(body(await parked)).toMatchObject({ state: "cancelled" });
    await route(reply());
    await tick();
    expect(told).toEqual([expect.stringContaining("Nobody is waiting")]);
  });
});

test("typing stops a waiter: the relay says which, for its ✅ to be edited; a crossed one isn't", async () => {
  const cancelled: string[] = [];
  const { relay, stop, wait, reply, route } = broker((waiter) => {
    cancelled.push(`${waiter.sessionId}#${waiter.generation}`);
  });
  const generation = stop();
  void wait(generation);
  relay.cancel(ID, Date.now());
  expect(cancelled).toEqual([`${ID}#${generation}`]);
  const next = stop();
  void wait(next);
  await route(reply());
  relay.cancel(ID, Date.now());
  expect(cancelled).toHaveLength(1);
});

describe("the right waiter", () => {
  test("a late cancel, typed before a newer stop, leaves that stop's waiter waiting", async () => {
    const { relay, sessions, stop, wait, reply, route } = broker();
    const typedAt = Date.now() - 5000;
    const generation = stop();
    const parked = wait(generation);
    await tick();
    expect(relay.cancel(ID, typedAt)).toBe(generation);
    expect(sessions.get(ID)?.generation).toBe(generation);
    await route(reply());
    expect(body(await parked)).toMatchObject({ state: "reply" });
  });

  test("an old waiter that ends after its replacement registered leaves the session listening", async () => {
    const { relay, stop, wait, reply, route } = broker();
    const old = stop();
    const oldParked = wait(old);
    const current = stop();
    expect(body(await oldParked)).toMatchObject({ state: "stale" });
    const parked = wait(current);
    relay.end({ session_id: ID, generation: old });
    await route(reply());
    expect(body(await parked)).toMatchObject({ state: "reply" });
  });
});

describe("the broker down", () => {
  test("a waiter that ends while the broker is down: applied at start, so nobody listens", async () => {
    const first = broker();
    const generation = first.stop();
    void first.wait(generation);
    first.relay.close();
    first.db.close();
    writePending(paths, { kind: "end", sessionId: ID, generation, at: Date.now() });
    const second = broker();
    await second.recover();
    await second.route(second.reply());
    await tick();
    expect(told).toEqual([expect.stringContaining("Nobody is waiting")]);
  });

  test("typing while the broker is down: the cancel comes first at start, then the stored reply", async () => {
    const first = broker();
    const generation = first.stop();
    void first.wait(generation);
    const update = first.reply();
    first.relay.close();
    first.db.close();
    writePending(paths, { kind: "cancel", sessionId: ID, at: Date.now() + 1 });
    const second = broker();
    await second.recover();
    await tick();
    expect(body(await second.wait(generation))).toMatchObject({ state: "cancelled" });
    expect(told).toEqual([expect.stringContaining("Nobody is waiting")]);
    expect(update).toBeGreaterThan(0);
  });
});

describe("a broker crash at each boundary", () => {
  test("a crash after storing a reply: at start it goes to the waiter", async () => {
    const first = broker();
    const generation = first.stop();
    void first.wait(generation);
    first.reply();
    first.relay.close();
    first.db.close();
    const second = broker();
    await second.recover();
    expect(body(await second.wait(generation))).toMatchObject({
      state: "reply",
      text: "now say bye",
    });
  });

  test("a crash after handing it over: the waiter confirms to the next broker", async () => {
    const first = broker();
    const generation = first.stop();
    const parked = first.wait(generation);
    const update = first.reply();
    await first.route(update);
    expect(body(await parked)).toMatchObject({ state: "reply" });
    first.db.close();
    const second = broker();
    await second.recover();
    const confirm = second.relay.confirm({ session_id: ID, generation, update_id: update });
    expect(body(confirm)).toMatchObject({ delivered: true });
    expect(told).toEqual([]);
  });

  test("a crash after handing it over, and the waiter is gone too: reported, never resent", async () => {
    const first = broker();
    const generation = first.stop();
    const parked = first.wait(generation);
    await first.route(first.reply());
    await parked;
    first.db.close();
    dead.add(HOOK.pid);
    const second = broker();
    await second.recover();
    await tick();
    expect(told).toEqual([expect.stringContaining("never confirmed")]);
    const again = second.wait(generation);
    expect(body(await again)).toMatchObject({ state: "ended" });
  });
});

test("a reply the hook confirms marks its session as working: `claude -p` sends no prompt event (plan 7.7)", async () => {
  const { relay, sessions, stop, wait, reply, route } = broker();
  const generation = stop();
  const parked = wait(generation);
  const update = reply();
  await route(update);
  await parked;
  const before = Date.now();
  expect(sessions.get(ID)?.promptedAt).toBe(0);
  relay.confirm({ session_id: ID, generation, update_id: update });
  expect(sessions.get(ID)?.promptedAt).toBeGreaterThanOrEqual(before);
});
