import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandName } from "../../src/broker/commands.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { handleUpdate } from "../../src/broker/gate.ts";
import { MAX_ATTEMPTS, Pairing } from "../../src/broker/pairing.ts";
import type { Log } from "../../src/shared/log.ts";
import type { SendMessageParams, Update } from "../../src/shared/telegram/types.ts";

// Plan 2.4's pass checks: a wrong or expired code, another user and a group chat are all refused.
const dir = mkdtempSync(join(tmpdir(), "tg-gate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const you = { id: 4242, is_bot: false, first_name: "Hamed", username: "hamed" };
const stranger = { id: 666, is_bot: false, first_name: "Mallory" };
const bot = { id: 999, is_bot: true, first_name: "OtherBot" };
const privateChat = (id: number) => ({ id, type: "private" });
const group = { id: -100123, type: "supergroup" };
const SECRET_TEXT = "a message whose text must never reach the log";

let sent: SendMessageParams[] = [];
let logged: string[] = [];
let commands: CommandName[] = [];
let presses: string[] = [];
let pairing: Pairing;
let nextId = 0;
beforeEach(() => {
  sent = [];
  logged = [];
  commands = [];
  presses = [];
  pairing = new Pairing(BrokerDb.open(join(dir, `gate-${Date.now()}-${nextId}.db`)));
});

const log: Log = (event, fields) => logged.push(JSON.stringify({ event, ...fields }));
const telegram = {
  sendMessage: (params: SendMessageParams) => {
    sent.push(params);
    return Promise.resolve({ message_id: 1, date: 0, chat: privateChat(params.chat_id) });
  },
};

function message(
  from: typeof you | typeof stranger | typeof bot,
  chat: { id: number; type: string },
  text: string,
): Update {
  nextId += 1;
  return {
    update_id: nextId,
    kind: "message",
    message: { message_id: nextId, date: 0, chat, from, text },
  };
}

const command = (name: CommandName) => {
  commands.push(name);
  return `answer to /${name}`;
};
const press = (data: string, chat: number, queryId: string) => {
  presses.push(`${data} ${chat} ${queryId}`);
  return Promise.resolve();
};
const handle = (update: Update) => handleUpdate(update, { telegram, pairing, log, command, press });
const reasons = () =>
  logged.filter((line) => line.includes("update.dropped")).map((line) => JSON.parse(line).reason);

describe("pairing through /pair", () => {
  test("the right code in a private chat pairs the sender, who gets 'Paired ✅'", async () => {
    const { code } = pairing.start();
    await handle(message(you, privateChat(you.id), `/pair ${code}`));
    expect(pairing.pairedUser()).toEqual({ id: you.id, name: "Hamed (@hamed)" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chat_id: you.id,
      text: expect.stringMatching(/^Paired ✅/),
    });
  });

  test("a wrong code is refused, with the tries left; too many cancel the pairing", async () => {
    const { code } = pairing.start();
    await handle(message(stranger, privateChat(stranger.id), "/pair AAAA-AAAA"));
    expect(sent.at(-1)?.text).toStartWith(`❌ Wrong code: ${MAX_ATTEMPTS - 1} tries left.`);
    for (let n = 2; n <= MAX_ATTEMPTS; n += 1) {
      await handle(message(stranger, privateChat(stranger.id), "/pair BBBB-BBBB"));
    }
    expect(sent.at(-1)?.text).toStartWith("❌ Too many wrong codes");
    await handle(message(you, privateChat(you.id), `/pair ${code}`));
    expect(pairing.pairedUser()).toBeUndefined();
  });

  test("an expired code, or none pending: no answer, nobody paired", async () => {
    await handle(message(you, privateChat(you.id), "/pair AAAA-AAAA"));
    expect(sent).toEqual([]);
    expect(pairing.pairedUser()).toBeUndefined();
  });

  test("in a group chat, even with the right code: dropped, not paired, not counted", async () => {
    const { code } = pairing.start();
    await handle(message(you, group, `/pair ${code}`));
    expect(pairing.pairedUser()).toBeUndefined();
    expect(sent).toEqual([]);
    expect(reasons()).toEqual(["not a private chat"]);
    await handle(message(you, privateChat(you.id), `/pair ${code}`));
    expect(pairing.pairedUser()?.id).toBe(you.id);
  });
});

describe("after pairing, only the paired user in a private chat is heard", () => {
  test("the paired user is accepted; another user, a group and a bot are dropped", async () => {
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    await handle(message(you, privateChat(you.id), SECRET_TEXT));
    await handle(message(stranger, privateChat(stranger.id), SECRET_TEXT));
    await handle(message(you, group, SECRET_TEXT));
    await handle(message(bot, privateChat(bot.id), SECRET_TEXT));
    expect(logged.filter((line) => line.includes("update.accepted"))).toHaveLength(1);
    expect(reasons()).toEqual(["not the paired user", "not a private chat", "sent by a bot"]);
    expect(sent).toEqual([]);
    expect(logged.join("\n")).not.toContain(SECRET_TEXT);
  });

  test("the paired user's button press is handed on, with its chat and query id", async () => {
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    const press = {
      id: "cb7",
      from: you,
      data: "full:0123456789abcdef",
      message: { message_id: 5, chat: privateChat(you.id) },
    };
    await handle({ update_id: 52, kind: "callback_query", callback_query: press });
    expect(presses).toEqual([`full:0123456789abcdef ${you.id} cb7`]);
    expect(logged.join("\n")).not.toContain("0123456789abcdef");
  });

  test("a button press from another user, and an update of another kind, are dropped", async () => {
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    const press = {
      id: "cb1",
      from: stranger,
      data: "q:0",
      message: { message_id: 5, chat: privateChat(stranger.id) },
    };
    await handle({ update_id: 50, kind: "callback_query", callback_query: press });
    await handle({ update_id: 51, kind: "other" });
    expect(reasons()).toEqual(["not the paired user", "not a message or a button press"]);
    expect(presses).toEqual([]);
  });

  test("before any pairing, every message is dropped", async () => {
    await handle(message(you, privateChat(you.id), "hello"));
    expect(reasons()).toEqual(["not paired yet"]);
    expect(sent).toEqual([]);
  });
});

describe("commands of the paired user (plan 2.6)", () => {
  test("/status and /away@SomeBot are carried out and answered in their chat", async () => {
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    await handle(message(you, privateChat(you.id), "/status"));
    await handle(message(you, privateChat(you.id), "/away@SomeBot"));
    expect(commands).toEqual(["status", "away"]);
    expect(sent).toEqual([
      { chat_id: you.id, text: "answer to /status" },
      { chat_id: you.id, text: "answer to /away" },
    ]);
  });

  test("anyone else's command, or one in a group, is dropped unanswered", async () => {
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    await handle(message(stranger, privateChat(stranger.id), "/away"));
    await handle(message(you, group, "/off"));
    expect(commands).toEqual([]);
    expect(sent).toEqual([]);
    expect(reasons()).toEqual(["not the paired user", "not a private chat"]);
  });

  test("before pairing /status is dropped; after it, a plain message is only accepted", async () => {
    await handle(message(you, privateChat(you.id), "/status"));
    expect(reasons()).toEqual(["not paired yet"]);
    pairing.attempt(pairing.start().code, { id: you.id, name: "Hamed" });
    await handle(message(you, privateChat(you.id), "status please"));
    expect(commands).toEqual([]);
    expect(sent).toEqual([]);
    expect(logged.filter((line) => line.includes("update.accepted"))).toHaveLength(1);
  });
});
