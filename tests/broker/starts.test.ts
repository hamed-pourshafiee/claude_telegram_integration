import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { START_MS, Starts } from "../../src/broker/starts.ts";

// Plan 7.7: the questions /new asked. A reply starts a session in the question's folder, once.
const dir = mkdtempSync(join(tmpdir(), "tg-starts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let clock = 1_000_000;
const starts = new Starts(BrokerDb.open(join(dir, "starts.db")), () => clock);

test("a question starts one session: the first reply takes it, a second doesn't", () => {
  starts.record(4242, 70, "/work/sandbox");
  expect(starts.find(4242, 70)).toEqual({
    chatId: 4242,
    messageId: 70,
    projectDir: "/work/sandbox",
    askedAt: 1_000_000,
    state: "open",
  });
  expect(starts.use({ chatId: 4242, messageId: 70 })).toBe("used");
  expect(starts.use({ chatId: 4242, messageId: 70 })).toBe("taken");
  expect(starts.use({ chatId: 4242, messageId: 99 })).toBe("taken");
});

test("a reply after 30 minutes starts nothing; a week later the question is forgotten", () => {
  starts.record(4242, 71, "/work/app");
  clock += START_MS;
  expect(starts.use({ chatId: 4242, messageId: 71 })).toBe("expired");
  expect(starts.find(4242, 71)?.state).toBe("expired");
  clock += 7 * 24 * 60 * 60 * 1000;
  expect(starts.prune()).toBe(2);
  expect(starts.find(4242, 71)).toBeUndefined();
});
