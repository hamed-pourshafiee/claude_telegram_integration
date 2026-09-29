import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { type AskHarness, askHarness, CHAT, FOLDERS } from "../helpers/asks.ts";
import { until } from "../helpers/wait.ts";

// Plan 4.1 (flow 3): where Claude's questions go, and how a waiting question hook gets its answers.
const dir = mkdtempSync(join(tmpdir(), "tg-ask-relay-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const fresh = (dead?: Set<number>) => {
  files += 1;
  return askHarness(join(dir, `asks-${files}.db`), dead);
};

/** A call recorded in the panel on 2026-09-28: "Which color do you prefer?" Red, Green or Blue. */
const COLOR = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/hooks/claude-vscode/PreToolUse-AskUserQuestion.json"),
    "utf8",
  ),
).input.tool_input;

const body = (answer: Answer) => answer.body as Record<string, unknown>;

/** Whether the hook's Ask has its answer yet. */
function settled(answer: Promise<Answer>): () => boolean {
  let done = false;
  void answer.then(() => (done = true));
  return () => done;
}

async function posted(h: AskHarness, count: number): Promise<void> {
  expect(await until(() => h.posted.length >= count)).toBe(true);
}

describe("where a call goes (flow 3)", () => {
  test("at the Mac: to the dialog at once, and nothing to the chat", async () => {
    const h = fresh();
    h.be("active");
    expect(body(await h.ask("toolu_1", COLOR))).toMatchObject({ state: "local" });
    expect(h.posted).toEqual([]);
    expect(h.hurried()).toBe(false);
  });

  test("away: to the chat, one message per question, with a button per option", async () => {
    const h = fresh();
    void h.ask("toolu_1", COLOR);
    await posted(h, 1);
    expect(h.posted[0]?.header).toBe("❓ sandbox · 5e55 asks");
    expect(h.posted[0]?.body).toContain("**Color:** Which color do you prefer?");
    expect(h.posted[0]?.rows.map((row) => row[0]?.text)).toEqual([
      "Red",
      "Green",
      "Blue",
      "🖥 Answer at the Mac",
    ]);
  });

  test("a ping-only folder, muted, or a call that can't be read: to the dialog", async () => {
    const h = fresh();
    const cases = [
      ["toolu_1", COLOR, FOLDERS.private],
      ["toolu_2", { questions: [] }, FOLDERS.sandbox],
    ] as const;
    for (const [id, input, projectDir] of cases) {
      expect(body(await h.ask(id, input, { projectDir }))).toMatchObject({ state: "local" });
    }
    h.be("away", "off");
    expect(body(await h.ask("toolu_3", COLOR))).toMatchObject({ state: "local" });
    expect(h.posted).toEqual([]);
  });
});

describe("answered from the chat", () => {
  test("a tap answers; the hook confirms, then hands Claude the answers (F4)", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    expect(h.hurried()).toBe(true);
    await h.chat.press(`ask:${h.idOf("toolu_1")}:0:2`, "q1");
    expect(body(await waiting)).toMatchObject({
      state: "answered",
      answers: { "Which color do you prefer?": "Blue" },
    });
    expect(h.toasts).toEqual([{ callback_query_id: "q1" }]);
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]).toMatchObject({ chat_id: CHAT, message_id: 101 });
    expect(h.edits[0]?.text).toEndWith("\n\n✅ Blue");
    expect(h.edits[0]?.reply_markup).toBeUndefined();
    const confirm = { session_id: "5e551011-aaaa", tool_use_id: "toolu_1" };
    expect(body(h.relay.confirm(confirm))).toMatchObject({ delivered: true });
    // Asked again after a reconnect: still yes, and the Ask still has its answers.
    expect(body(h.relay.confirm(confirm))).toMatchObject({ delivered: true });
    expect(body(await h.ask("toolu_1", COLOR))).toMatchObject({ state: "answered" });
    expect(h.hurried()).toBe(false);
  });

  test("PostToolUse closes the call, and its text goes (D8)", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    await h.chat.press(`ask:${h.idOf("toolu_1")}:0:0`, "q1");
    await waiting;
    h.relay.confirm({ session_id: "5e551011-aaaa", tool_use_id: "toolu_1" });
    h.relay.asked("5e551011-aaaa", "toolu_1");
    const ask = h.asks.get(h.idOf("toolu_1"));
    expect(ask).toMatchObject({ state: "closed", input: undefined });
    expect(h.asks.questions(ask?.id ?? "").map((q) => [q.html, q.answer])).toEqual([
      ["", undefined],
    ]);
  });
});

describe("to the Mac after all", () => {
  test("in between, a question is held in the chat and goes to the Mac at your first touch", async () => {
    const h = fresh();
    h.be("between");
    const waiting = h.ask("toolu_1", COLOR);
    const done = settled(waiting);
    await posted(h, 1);
    expect(h.hurried()).toBe(true);
    await Bun.sleep(20);
    expect(done()).toBe(false);
    h.be("active");
    expect(body(await waiting)).toMatchObject({ state: "local" });
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("🖥 Moved to the Mac: answer it there.");
    expect(h.hurried()).toBe(false);
  });

  test("in away mode, input changes nothing: the question stays in the chat", async () => {
    const h = fresh();
    h.be("away", "away");
    const done = settled(h.ask("toolu_1", COLOR));
    await posted(h, 1);
    h.be("away", "away");
    await Bun.sleep(20);
    expect(done()).toBe(false);
  });

  test("/local and the 🖥 button hand calls back to the dialog", async () => {
    const h = fresh();
    const first = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    expect(h.chat.handBack()).toBe("🖥 The question went back to the Mac.");
    expect(body(await first)).toMatchObject({ state: "local" });
    expect(h.chat.handBack()).toBe("No question is waiting here.");
    const second = h.ask("toolu_2", COLOR);
    await posted(h, 2);
    await h.chat.press(`ask:${h.idOf("toolu_2")}:mac`, "q2");
    expect(body(await second)).toMatchObject({ state: "local" });
    expect(h.toasts).toEqual([{ callback_query_id: "q2", text: "🖥 Moved to the Mac." }]);
  });
});

describe("when the hook stops waiting", () => {
  test("SIGTERM (Esc at the Mac): the question is withdrawn in the chat", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    h.relay.end({ session_id: "5e551011-aaaa", tool_use_id: "toolu_1" });
    expect(body(await waiting)).toMatchObject({ state: "ended" });
    expect(await until(() => h.edits.length === 1)).toBe(true);
    expect(h.edits[0]?.text).toEndWith("⏹ No longer asked: Claude stopped waiting at the Mac.");
    expect(h.sent).toEqual([]);
  });

  test("answers it never took are announced, not only edited in (D7)", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    await h.chat.press(`ask:${h.idOf("toolu_1")}:0:1`, "q1");
    await waiting;
    h.relay.end({ session_id: "5e551011-aaaa", tool_use_id: "toolu_1" });
    expect(await until(() => h.sent.length === 1)).toBe(true);
    expect(h.sent[0]).toMatchObject({
      chat_id: CHAT,
      text: expect.stringContaining("before your answers went in"),
      reply_parameters: { message_id: 101 },
    });
    expect(
      body(h.relay.confirm({ session_id: "5e551011-aaaa", tool_use_id: "toolu_1" })),
    ).toMatchObject({
      delivered: false,
    });
  });

  test("a restarted broker ends calls whose hook is gone; a waiting hook asks it again", async () => {
    files += 1;
    const file = join(dir, `asks-${files}.db`);
    const before = askHarness(file);
    void before.ask("toolu_1", COLOR, { pid: 31 });
    void before.ask("toolu_2", { ...COLOR, title: "Second" }, { pid: 32 });
    await posted(before, 2);
    const after = askHarness(file, new Set([31]));
    after.relay.recover();
    expect(after.asks.get(before.idOf("toolu_1"))?.state).toBe("ended");
    expect(after.asks.get(before.idOf("toolu_2"))?.state).toBe("remote");
    const again = after.ask("toolu_2", COLOR, { pid: 32 });
    await after.chat.press(`ask:${before.idOf("toolu_2")}:0:0`, "q");
    expect(body(await again)).toMatchObject({ answers: { "Which color do you prefer?": "Red" } });
    expect(after.posted).toEqual([]);
  });
});

describe("left open at the Mac (flow 3)", () => {
  test("once you're away you hear of it, once; its text comes along", async () => {
    const h = fresh();
    h.be("active");
    await h.ask("toolu_1", COLOR);
    h.be("between");
    expect(h.told).toEqual([]);
    h.be("away");
    await until(() => h.told.length === 1);
    expect(h.told[0]?.header).toBe("❓ sandbox · 5e55 has a question waiting at the computer");
    expect(h.told[0]?.body).toContain("Which color do you prefer?\n- Red\n- Green\n- Blue");
    h.be("active");
    h.be("away");
    await Bun.sleep(20);
    expect(h.told).toHaveLength(1);
  });

  test("answered at the Mac (PostToolUse), or the turn moved on: nothing to hear of", async () => {
    const h = fresh();
    h.be("active");
    await h.ask("toolu_1", COLOR);
    await h.ask("toolu_2", { ...COLOR, title: "Other" });
    h.relay.asked("5e551011-aaaa", "toolu_1");
    h.relay.moved("5e551011-aaaa");
    h.be("away");
    await Bun.sleep(20);
    expect(h.told).toEqual([]);
  });
});

describe("text kept only until the call is settled (D8)", () => {
  test("an edit that finishes after PostToolUse closed the call doesn't bring its text back", async () => {
    files += 1;
    const h = askHarness(join(dir, `asks-${files}.db`), new Set(), 60);
    const waiting = h.ask("toolu_1", COLOR);
    await posted(h, 1);
    await h.chat.press(`ask:${h.idOf("toolu_1")}:0:0`, "q1");
    await waiting;
    h.relay.confirm({ session_id: "5e551011-aaaa", tool_use_id: "toolu_1" });
    h.relay.asked("5e551011-aaaa", "toolu_1");
    // The "✅ Red" edit is on its way; it lands after the call closed, as it did live (455 ms).
    expect(h.edits).toHaveLength(1);
    await Bun.sleep(120);
    expect(h.asks.questions(h.idOf("toolu_1")).map((question) => question.html)).toEqual([""]);
  });
});
