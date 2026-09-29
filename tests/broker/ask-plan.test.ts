import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { askHarness, CHAT } from "../helpers/asks.ts";
import { until } from "../helpers/wait.ts";

// Plan 4.2: a plan waiting for approval (ExitPlanMode) goes the way of a question (flow 3).
const dir = mkdtempSync(join(tmpdir(), "tg-ask-plan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const fresh = () => {
  files += 1;
  return askHarness(join(dir, `plans-${files}.db`));
};

const PLAN = { plan: "# Add q.py\n\n1. Write q.py.\n2. Run it." };
const body = (answer: Answer) => answer.body as Record<string, unknown>;

describe("a plan waiting for approval", () => {
  test("away: the plan comes to the chat; Approve is the answer the hook gets", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_p", PLAN);
    expect(await until(() => h.posted.length === 1)).toBe(true);
    expect(h.posted[0]?.header).toBe("📋 sandbox · 5e55 has a plan ready");
    expect(h.posted[0]?.body).toStartWith("# Add q.py\n\n1. Write q.py.");
    expect(h.posted[0]?.rows.map((row) => row[0]?.text)).toEqual([
      "Approve",
      "Keep planning",
      "🖥 Answer at the Mac",
    ]);
    await h.chat.press(`ask:${h.idOf("toolu_p")}:0:0`, "q");
    expect(body(await waiting)).toMatchObject({ answers: { "Approve this plan?": "Approve" } });
  });

  test("a reply to the plan is what to change", async () => {
    const h = fresh();
    const waiting = h.ask("toolu_p", PLAN);
    expect(await until(() => h.posted.length === 1)).toBe(true);
    const target = h.chat.questionAt(CHAT, 101) ?? { sessionId: "" };
    expect(h.chat.answerText(target, "Also add a test")).toEqual({ outcome: "answered" });
    expect(body(await waiting)).toMatchObject({
      answers: { "Approve this plan?": "Also add a test" },
    });
  });

  test("left open at the Mac: you hear it waits there to be approved", async () => {
    const h = fresh();
    h.be("active");
    expect(body(await h.ask("toolu_p", PLAN))).toMatchObject({ state: "local" });
    h.be("away");
    expect(await until(() => h.told.length === 1)).toBe(true);
    expect(h.told[0]).toEqual({
      header: "📋 sandbox · 5e55 has a plan waiting at the computer",
      body: "It opened while you were at the Mac, so it can only be approved there.",
    });
  });
});
