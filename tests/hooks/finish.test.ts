import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEntries, classifyStop } from "../../src/hooks/finish.ts";
import { readTail } from "../../src/shared/transcript.ts";
import { Transcript } from "../helpers/transcript.ts";

// Flow 1 and F16: a stop's outcome from the entries written for it. Plan 2.8 adds recorded sequences.
const dir = mkdtempSync(join(tmpdir(), "tg-finish-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const REPLY = "Done: the tests pass.";
const outcome = (transcript: Transcript, text = REPLY, prompt: string | undefined = "p1") =>
  classifyEntries(transcript.entries, text, prompt)?.outcome;

describe("one stop", () => {
  test("assistant → summary: a real finish", () => {
    const t = new Transcript().prompt("p1").thinking().assistant(REPLY).summary();
    expect(outcome(t)).toBe("finish");
  });

  test("a Stop hook blocked it (hook_blocking_error): Claude continues", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).blocked("p1").summary();
    expect(outcome(t)).toBe("continuing");
  });

  test("a Stop hook added context (hook_additional_context): Claude continues", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).attachment("hook_additional_context");
    expect(outcome(t.summary())).toBe("continuing");
  });

  test("blocked, but the summary says preventedContinuation: a finish", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).blocked("p1");
    expect(outcome(t.summary({ preventedContinuation: true }))).toBe("finish");
  });

  test("a Stop hook crashed (a non-blocking error in hookErrors): a finish", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY);
    expect(outcome(t.summary({ hookErrors: ["exit 1"] }))).toBe("finish");
  });

  test("no summary yet: undefined, so the hook reads again", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY);
    expect(classifyEntries(t.entries, REPLY, "p1")).toBeUndefined();
    t.blocked("p1");
    expect(classifyEntries(t.entries, REPLY, "p1")).toBeUndefined();
  });

  test("a message of several text blocks, one entry each, matches their joined text", () => {
    const t = new Transcript().prompt("p1").assistant(["Done.", "The tests pass."]).summary();
    expect(outcome(t, "Done.\nThe tests pass.")).toBe("finish");
  });

  test("the summary's Claude Code version comes along, for ctl doctor (plan 6.1)", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).blocked("p1");
    expect(classifyEntries(t.summary({ version: "2.1.284" }).entries, REPLY, "p1")).toEqual({
      outcome: "continuing",
      reason: "continuation entry",
      version: "2.1.284",
    });
    const unnamed = new Transcript().prompt("p1").assistant(REPLY).summary();
    expect(classifyEntries(unnamed.entries, REPLY, "p1")).not.toHaveProperty("version");
  });
});

describe("the right stop", () => {
  test("blocked, then the same text again after the continuation: the latest stop decides", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).blocked("p1").summary();
    expect(outcome(t)).toBe("continuing");
    t.toolResult("p1").assistant(REPLY).summary();
    expect(outcome(t)).toBe("finish");
  });

  test("the same final text in two turns: the stop of this prompt, not the earlier one", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).summary();
    t.prompt("p2").assistant(REPLY);
    // p2's stop has no summary yet: p1's finish must not be taken for it.
    expect(classifyEntries(t.entries, REPLY, "p2")).toBeUndefined();
    t.blocked("p2").summary();
    expect(outcome(t, REPLY, "p2")).toBe("continuing");
  });

  test("this turn's reply not written yet: the last turn's identical, finished stop isn't taken", () => {
    const t = new Transcript()
      .prompt("p1")
      .assistant(REPLY)
      .summary()
      .prompt("p2")
      .toolResult("p2");
    expect(classifyEntries(t.entries, REPLY, "p2")).toBeUndefined();
    t.assistant(REPLY).blocked("p2").summary();
    expect(outcome(t, REPLY, "p2")).toBe("continuing");
  });

  test("another text: no stop found", () => {
    const t = new Transcript().prompt("p1").assistant(REPLY).summary();
    expect(classifyEntries(t.entries, "something else", "p1")).toBeUndefined();
  });
});

describe("reading the transcript", () => {
  test("a partial last line is skipped, and the window's cut first line too", () => {
    const file = join(dir, "partial.jsonl");
    const t = new Transcript().prompt("p1").assistant(REPLY).summary();
    writeFileSync(file, `${"x".repeat(50)}\n${t.jsonl()}{"type":"assist`);
    expect(readTail(file, 10_000_000)).toHaveLength(3);
    const size = t.jsonl().length + 20;
    expect(readTail(file, size)).toHaveLength(3);
  });

  test("the summary written before the hook looks: found at once", async () => {
    const file = join(dir, "before.jsonl");
    writeFileSync(file, new Transcript().prompt("p1").assistant(REPLY).summary().jsonl());
    const facts = { transcriptPath: file, lastMessage: REPLY, promptId: "p1" };
    expect(await classifyStop(facts, { timeoutMs: 0 })).toEqual({
      outcome: "finish",
      reason: "no continuation entry",
    });
  });

  test("the summary written while the hook waits: found then", async () => {
    const file = join(dir, "later.jsonl");
    const t = new Transcript().prompt("p1").assistant(REPLY);
    writeFileSync(file, t.jsonl());
    const facts = { transcriptPath: file, lastMessage: REPLY, promptId: "p1" };
    const result = classifyStop(facts, { timeoutMs: 5000, pollMs: 20 });
    await Bun.sleep(100);
    const before = t.jsonl().length;
    appendFileSync(file, t.blocked("p1").summary().jsonl().slice(before));
    expect((await result).outcome).toBe("continuing");
  });

  test("no summary in time, no transcript, or no text: unknown", async () => {
    const file = join(dir, "never.jsonl");
    writeFileSync(file, new Transcript().prompt("p1").assistant(REPLY).jsonl());
    const quick = { timeoutMs: 100, pollMs: 20 };
    const facts = { transcriptPath: file, lastMessage: REPLY, promptId: "p1" };
    expect(await classifyStop(facts, quick)).toEqual({
      outcome: "unknown",
      reason: "no summary in time",
    });
    const missing = { ...facts, transcriptPath: join(dir, "missing.jsonl") };
    expect(await classifyStop(missing, quick)).toMatchObject({ outcome: "unknown" });
    expect(await classifyStop({ ...facts, lastMessage: " " }, quick)).toMatchObject({
      reason: "no last assistant message",
    });
  });
});
