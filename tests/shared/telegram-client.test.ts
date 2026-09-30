import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Secret } from "../../src/shared/secret.ts";
import { TelegramClient } from "../../src/shared/telegram/client.ts";
import { FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";

const fake = new FakeTelegram();
beforeEach(() => fake.reset());
afterAll(() => fake.stop());

const bot = { id: 7777777777, is_bot: true, first_name: "Bridge", username: "bridge_test_bot" };
const chat = { id: 4242, type: "private" };
const you = { id: 4242, is_bot: false, first_name: "Hamed" };
const DATE = 1_790_000_000;

function client(): TelegramClient {
  return new TelegramClient({ token: new Secret(FAKE_TOKEN), apiBase: fake.url });
}

describe("each call reaches the Bot API with the token and returns a checked answer", () => {
  test("getMe", async () => {
    fake.answer("getMe", ok(bot));
    expect(await client().getMe()).toEqual(bot);
    expect(fake.calls("getMe")).toEqual([{ method: "getMe", token: FAKE_TOKEN, body: {} }]);
  });

  test("sendMessage", async () => {
    const params = {
      chat_id: chat.id,
      text: "✅ <b>done</b>",
      parse_mode: "HTML" as const,
      reply_parameters: { message_id: 9 },
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "q1:0" }]] },
      link_preview_options: { is_disabled: true },
    };
    fake.answer(
      "sendMessage",
      ok({ message_id: 10, date: DATE, chat, from: bot, text: "✅ done" }),
    );
    const message = await client().sendMessage(params);
    expect(message).toEqual({ message_id: 10, date: DATE, chat, from: bot, text: "✅ done" });
    expect(fake.calls("sendMessage")[0]?.body).toEqual(params);
  });

  test("editMessageText", async () => {
    const params = { chat_id: chat.id, message_id: 10, text: "↩️ continued at the computer" };
    fake.answer("editMessageText", ok({ message_id: 10, date: DATE, chat, text: params.text }));
    expect((await client().editMessageText(params)).text).toBe(params.text);
    expect(fake.calls("editMessageText")[0]?.body).toEqual(params);
  });

  test("answerCallbackQuery", async () => {
    fake.answer("answerCallbackQuery", ok(true));
    await client().answerCallbackQuery({ callback_query_id: "cb1", text: "Sent" });
    expect(fake.calls("answerCallbackQuery")[0]?.body).toEqual({
      callback_query_id: "cb1",
      text: "Sent",
    });
  });

  test("setMyCommands: one chat's menu (plan 7.1); an answer other than true is an error", async () => {
    const params = {
      commands: [{ command: "status", description: "Where you are" }],
      scope: { type: "chat" as const, chat_id: chat.id },
    };
    fake.answer("setMyCommands", ok(true), ok(false));
    await client().setMyCommands(params);
    expect(fake.calls("setMyCommands")[0]?.body).toEqual(params);
    await expect(client().setMyCommands(params)).rejects.toThrow("setMyCommands");
  });
});

describe("sendDocument", () => {
  test("uploads the text as a .md file", async () => {
    fake.answer("sendDocument", ok({ message_id: 12, date: DATE, chat, from: bot }));
    const message = await client().sendDocument({
      chat_id: chat.id,
      filename: "reply.md",
      content: "# The full reply\n",
      caption: "📄 full text",
      reply_parameters: { message_id: 11 },
    });
    expect(message.message_id).toBe(12);
    expect(fake.calls("sendDocument")[0]?.body).toEqual({
      chat_id: "4242",
      document: {
        name: "reply.md",
        type: expect.stringMatching(/^text\/markdown/),
        content: "# The full reply\n",
      },
      caption: "📄 full text",
      reply_parameters: '{"message_id":11}',
    });
  });
});

describe("getUpdates", () => {
  test("asks for messages and button presses, from the offset, with long polling", async () => {
    fake.answer("getUpdates", ok([]));
    expect(await client().getUpdates({ offset: 101, timeout: 1 })).toEqual([]);
    expect(fake.calls("getUpdates")[0]?.body).toEqual({
      offset: 101,
      timeout: 1,
      allowed_updates: ["message", "callback_query"],
    });
  });

  test("sorts updates by kind; another kind or a malformed one is 'other'", async () => {
    const reply = { message_id: 4, date: DATE, chat };
    const text = { message_id: 5, date: DATE, chat, from: you, text: "now say bye" };
    const press = {
      id: "cb1",
      from: you,
      data: "q1:0",
      message: { message_id: 6, date: DATE, chat },
    };
    fake.answer(
      "getUpdates",
      ok([
        { update_id: 101, message: { ...text, reply_to_message: reply } },
        { update_id: 102, callback_query: press },
        { update_id: 103, edited_message: text },
        { update_id: 104, message: { ...text, from: { id: "not a number" } } },
        { update_id: 105, message: { ...text, text: 42 } },
        { update_id: 106, callback_query: { ...press, from: undefined } },
        { message: text },
      ]),
    );
    expect(await client().getUpdates()).toEqual([
      {
        update_id: 101,
        kind: "message",
        message: { ...text, reply_to_message_id: 4 },
      },
      {
        update_id: 102,
        kind: "callback_query",
        callback_query: { id: "cb1", from: you, data: "q1:0", message: { message_id: 6, chat } },
      },
      { update_id: 103, kind: "other" },
      { update_id: 104, kind: "other" },
      { update_id: 105, kind: "other" },
      { update_id: 106, kind: "other" },
    ]);
  });
});
