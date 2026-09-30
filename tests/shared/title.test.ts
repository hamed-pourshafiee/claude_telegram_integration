import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields } from "../../src/shared/log.ts";
import { sessionTitle } from "../../src/shared/title.ts";

// Plan 7.2 (F21): a session's title as Claude Code shows it, from the entries it writes into the
// transcript, again and again: the one you gave it (custom-title), else the one it made (ai-title).
const dir = mkdtempSync(join(tmpdir(), "tg-title-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
let logged: { event: string; fields: LogFields }[] = [];
const log = (event: string, fields: LogFields) => logged.push({ event, fields });

const made = (title: string) => ({ type: "ai-title", aiTitle: title, sessionId: "s1" });
const given = (title: string) => ({ type: "custom-title", customTitle: title, sessionId: "s1" });
const turn = { type: "user", message: { role: "user", content: "hi" } };

/** A transcript of these entries, one JSON line each. */
function transcript(...entries: object[]): string {
  files += 1;
  const path = join(dir, `t${files}.jsonl`);
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

test("the one Claude Code made, the latest if it changed", () => {
  logged = [];
  const path = transcript(turn, made("Old title"), turn, made("Fix the login bug"), turn);
  expect(sessionTitle(path, log)).toBe("Fix the login bug");
  expect(logged).toEqual([]);
});

test("one you gave it wins, as in Claude Code; an empty one doesn't", () => {
  expect(sessionTitle(transcript(given("My name for it"), made("Made one")), log)).toBe(
    "My name for it",
  );
  expect(sessionTitle(transcript(given("  "), made("Made one")), log)).toBe("Made one");
});

test("none yet (a first turn), no transcript yet, or none named: undefined, and only a real failure logged", () => {
  logged = [];
  expect(sessionTitle(transcript(turn, turn), log)).toBeUndefined();
  expect(sessionTitle(join(dir, "not-there.jsonl"), log)).toBeUndefined();
  expect(sessionTitle(undefined, log)).toBeUndefined();
  expect(logged).toEqual([]);
  const folder = join(dir, "a-folder.jsonl");
  mkdirSync(folder);
  expect(sessionTitle(folder, log)).toBeUndefined();
  expect(logged).toEqual([{ event: "title.unreadable", fields: { error: "EISDIR" } }]);
});

test("only the transcript's end is read: a title further back doesn't count", () => {
  const filler = { type: "assistant", message: { content: "x".repeat(2_000) } };
  const path = transcript(made("Far back"), filler, filler, turn);
  expect(sessionTitle(path, log, 1_000_000)).toBe("Far back");
  expect(sessionTitle(path, log, 3_000)).toBeUndefined();
});
