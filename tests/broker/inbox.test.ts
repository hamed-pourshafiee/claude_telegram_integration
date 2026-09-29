import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Inbox } from "../../src/broker/inbox.ts";

// Plan 3.1 (D7): replies are stored once per update_id, and their text goes once they are settled.
const dir = mkdtempSync(join(tmpdir(), "tg-inbox-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const reply = { updateId: 900, chatId: 42, messageId: 7, replyTo: 3, text: "now say bye" };

test("an update Telegram sends again is stored once", () => {
  const inbox = new Inbox(BrokerDb.open(join(dir, "once.db")), () => 123);
  expect(inbox.store(reply)).toBe(true);
  expect(inbox.store({ ...reply, text: "changed" })).toBe(false);
  expect(inbox.get(900)).toMatchObject({ ...reply, receivedAt: 123, state: "new" });
  expect(inbox.unrouted().map((stored) => stored.updateId)).toEqual([900]);
});

test("handed keeps the text; delivered, unconfirmed and unrouted drop it", () => {
  const inbox = new Inbox(BrokerDb.open(join(dir, "settled.db")));
  const to = { sessionId: "b1e8", generation: 4 };
  for (const [index, state] of (["delivered", "unconfirmed", "unrouted"] as const).entries()) {
    const updateId = 900 + index;
    inbox.store({ ...reply, updateId });
    inbox.mark(updateId, "handed", to);
    expect(inbox.get(updateId)).toMatchObject({ state: "handed", text: reply.text, ...to });
    inbox.mark(updateId, state);
    expect(inbox.get(updateId)).toMatchObject({ state, text: "", ...to });
  }
  expect(inbox.unrouted()).toEqual([]);
});
