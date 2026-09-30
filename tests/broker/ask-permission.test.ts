import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { askHarness, CHAT, FOLDERS, SESSION } from "../helpers/asks.ts";
import { SAMPLES } from "../helpers/secret-samples.ts";
import { until } from "../helpers/wait.ts";

// Phase 5 (D9): a permission prompt for Bash, Edit or Write goes the way of a question (flow 3), shown
// whole; you allow it once, or deny it, with a reason; every step goes to the audit log.
const dir = mkdtempSync(join(tmpdir(), "tg-ask-permission-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const fresh = () => {
  files += 1;
  return askHarness(join(dir, `permissions-${files}.db`));
};

const prompt = (command: string) => ({
  permission: { tool: "Bash", input: { command }, cwd: FOLDERS.sandbox },
});
const body = (answer: Answer) => answer.body as Record<string, unknown>;
const events = (h: ReturnType<typeof fresh>) => h.audited.map((line) => line.event);

describe("a prompt relayed while you're away", () => {
  test("it comes whole, with Allow once and Deny; Allow once is the hook's answer", async () => {
    const h = fresh();
    const waiting = h.ask("perm_1", prompt("npm test"));
    expect(await until(() => h.posted.length === 1)).toBe(true);
    const [posted] = h.posted;
    expect(posted?.header).toBe("🔐 sandbox · 5e55 wants to run a command");
    expect(posted?.body).toContain("```sh\nnpm test\n```");
    expect(posted?.whole).toBe(true);
    expect(posted?.rows.map((row) => row[0]?.text)).toEqual([
      "Allow once",
      "Deny",
      "🖥 Answer at the Mac",
    ]);
    await h.chat.press(`ask:${h.idOf("perm_1")}:0:0`, "q");
    expect(body(await waiting)).toMatchObject({ answers: { "Allow this?": "Allow once" } });
    h.relay.confirm({ session_id: SESSION.session_id, tool_use_id: "perm_1" });
    expect(events(h)).toEqual(["permission.asked", "permission.answered", "permission.delivered"]);
    expect(h.audited[1]?.fields).toMatchObject({ tool: "Bash", decision: "allow", by: "telegram" });
    expect(h.audited[1]?.fields.ref).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a reply denies it with your reason", async () => {
    const h = fresh();
    const waiting = h.ask("perm_1", prompt("rm -rf build"));
    expect(await until(() => h.posted.length === 1)).toBe(true);
    const target = h.chat.questionAt(CHAT, 101) ?? { sessionId: "" };
    expect(h.chat.answerText(target, "Not now, keep the build")).toEqual({ outcome: "answered" });
    expect(body(await waiting)).toMatchObject({
      answers: { "Allow this?": "Not now, keep the build" },
    });
    expect(h.audited[1]?.fields).toMatchObject({ decision: "deny with a reason", reasonChars: 23 });
  });

  test("a very long command comes complete, never cut; past four messages, as a file", async () => {
    const h = fresh();
    const long = `echo ${"x".repeat(9_000)} END`;
    void h.ask("perm_1", prompt(long));
    expect(await until(() => h.posted.length === 1)).toBe(true);
    expect(h.posted[0]?.body).toContain(long);
    expect(h.documents).toEqual([]);
    const huge = `echo ${"y".repeat(20_000)} END`;
    void h.ask("perm_2", prompt(huge));
    expect(await until(() => h.posted.length === 2)).toBe(true);
    expect(h.documents[0]?.content).toContain(huge);
    expect(h.posted[1]?.body).toStartWith("The whole operation is in the file above:");
  });
});

test("a reply to any message of a long prompt answers that prompt, with another one waiting too", async () => {
  const h = fresh();
  void h.ask("perm_1", prompt("npm test"));
  expect(await until(() => h.posted.length === 1)).toBe(true);
  const second = h.ask("perm_2", prompt(`echo ${"x".repeat(9_000)} END`));
  expect(await until(() => h.posted.length === 2)).toBe(true);
  // perm_1 is message 101; perm_2 starts at 102, its buttons under its last message (the Codex review).
  expect(h.posted[1]?.messageId).toBeGreaterThan(102);
  const target = h.chat.questionAt(CHAT, 102);
  expect(target).toEqual({ askId: h.idOf("perm_2"), index: 0 });
  expect(h.chat.answerText(target ?? { sessionId: "" }, "Not that one")).toEqual({
    outcome: "answered",
  });
  expect(body(await second)).toMatchObject({ answers: { "Allow this?": "Not that one" } });
  expect(h.asks.get(h.idOf("perm_1"))?.state).toBe("remote");
});

describe("prompts kept at the Mac", () => {
  test("at the Mac: its dialog only; nothing comes here", async () => {
    const h = fresh();
    h.be("active");
    expect(body(await h.ask("perm_1", prompt("npm test")))).toMatchObject({ state: "local" });
    expect(h.posted).toEqual([]);
    expect(h.audited[0]).toMatchObject({ event: "permission.asked", fields: { relayed: false } });
  });

  test("one with a secret in it can't be shown whole, so it stays there; you hear it waits", async () => {
    const h = fresh();
    const secret = SAMPLES.find((sample) => sample.family === "Telegram bot token")?.line ?? "";
    expect(body(await h.ask("perm_1", prompt(secret)))).toMatchObject({ state: "local" });
    expect(h.posted).toEqual([]);
    expect(await until(() => h.told.length === 1)).toBe(true);
    expect(h.told[0]?.header).toBe(
      "🔐 sandbox · 5e55 is waiting for your permission at the computer",
    );
    expect(h.audited[0]?.fields).toMatchObject({ relayed: false, why: "secret" });
  });
});

describe("a prompt answered at the Mac, or never", () => {
  test("the turn moved on: it was answered at the Mac, and its waiting hook is let go", async () => {
    const h = fresh();
    const waiting = h.ask("perm_1", prompt("npm test"));
    expect(await until(() => h.posted.length === 1)).toBe(true);
    h.relay.moved(SESSION.session_id);
    expect(body(await waiting)).toMatchObject({ state: "local" });
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("🖥 Answered at the Mac.");
    expect(events(h)).toEqual(["permission.asked", "permission.at-mac"]);
  });

  test("its hook's timeout: no decision, and the prompt is withdrawn here", async () => {
    const h = fresh();
    const waiting = h.ask("perm_1", prompt("npm test"));
    expect(await until(() => h.posted.length === 1)).toBe(true);
    h.relay.end({ session_id: SESSION.session_id, tool_use_id: "perm_1" });
    expect(body(await waiting)).toMatchObject({ state: "ended" });
    expect(events(h)).toEqual(["permission.asked", "permission.ended"]);
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("⏹ No longer asked: Claude stopped waiting at the Mac.");
  });
});
