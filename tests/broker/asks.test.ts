import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asks } from "../../src/broker/asks.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { Sessions } from "../../src/broker/sessions.ts";

// The messages of a call's questions (schema 5, the Codex review): a reply to any message of a
// question finds it, and a week on they go with the call.
const dir = mkdtempSync(join(tmpdir(), "tg-asks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DAY = 24 * 60 * 60 * 1000;
const QUESTION = {
  questions: [
    { question: "Red or blue?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
  ],
};

function setup(name: string) {
  let now = 0;
  const db = BrokerDb.open(join(dir, `${name}.db`));
  new Sessions(db).touch({ id: "s1", projectDir: "/w", entrypoint: "cli" });
  const asks = new Asks(db, () => now);
  const create = (id: string, toolUseId: string) =>
    asks.create({
      id,
      sessionId: "s1",
      toolUseId,
      pid: 1,
      claudePid: 2,
      state: "remote",
      raw: JSON.stringify(QUESTION),
      count: 1,
    });
  return { asks, create, later: (ms: number) => (now += ms) };
}

test("every message of a question finds it; a week on, they go with the call", () => {
  const { asks, create, later } = setup("parts");
  create("0a1b2c3d", "t1");
  asks.parts("0a1b2c3d", 0, 42, [7, 8]);
  asks.shown("0a1b2c3d", 0, { chatId: 42, messageId: 8, html: "<b>Red or blue?</b>" });
  for (const message of [7, 8]) {
    expect(asks.at(42, message)).toMatchObject({ askId: "0a1b2c3d", index: 0 });
  }
  expect(asks.at(42, 9)).toBeUndefined();
  later(8 * DAY);
  expect(asks.prune()).toBe(1);
  expect(asks.at(42, 7)).toBeUndefined();
  expect(asks.at(42, 8)).toBeUndefined();
});

test("a call asked before schema 5 has only its last message, on its question: still found by it", () => {
  const { asks, create } = setup("before-parts");
  create("4e5f6a7b", "t1");
  asks.shown("4e5f6a7b", 0, { chatId: 42, messageId: 12, html: "<b>Red or blue?</b>" });
  expect(asks.at(42, 12)).toMatchObject({ askId: "4e5f6a7b", index: 0 });
});
