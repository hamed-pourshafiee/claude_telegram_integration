import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEntries, classifyStop } from "../../src/hooks/finish.ts";
import { readTail } from "../../src/shared/transcript.ts";
import {
  classifiedAt,
  EXPECTED,
  named,
  RECORDINGS,
  type Recording,
  summaryAt,
} from "../helpers/recordings.ts";

// Plan 2.8: finish detection (F16, flow 1) on real transcripts with throwaway Stop hooks: a stop blocked
// by a hook, one continued by additionalContext, a hook that crashes, blocked-then-final, a block with
// continue: false, and the same final text in two turns. Each stop is met as the waiter meets it.
const dir = mkdtempSync(join(tmpdir(), "tg-recorded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("every scenario is recorded, and Claude Code did what each set up", () => {
  const versions = new Set(RECORDINGS.map((recording) => recording.version));
  expect(versions.size).toBeGreaterThan(0);
  for (const version of versions) {
    const recorded = RECORDINGS.filter((recording) => recording.version === version);
    const scenarios = recorded.map((recording) => recording.scenario).sort();
    expect(scenarios).toEqual(Object.keys(EXPECTED).sort());
    for (const recording of recorded) {
      const truths = recording.stops.map((stop) => stop.truth);
      expect(truths).toEqual([...(EXPECTED[recording.scenario] ?? [])]);
    }
  }
});

describe.each(RECORDINGS.map((recording) => [named(recording), recording] as const))(
  "%s",
  (_, recording) => {
    test.each(recording.stops.map((stop, index) => [index + 1, stop.truth, stop] as const))(
      "stop %d (%s): nothing when its hook starts, its outcome once the summary is written",
      (_, truth, stop) => {
        expect(classifiedAt(recording, stop, stop.entriesAtStart)).toBeUndefined();
        const summary = summaryAt(recording, stop);
        expect(classifiedAt(recording, stop, summary + 1)?.outcome).toBe(truth);
      },
    );
  },
);

describe("a recorded transcript, read while it is written", () => {
  const recording = RECORDINGS.find((each) => each.scenario === "block") as Recording;
  const [stop] = recording.stops;
  if (stop === undefined) throw new Error("no stop in the block recording");
  const summary = summaryAt(recording, stop);
  const upTo = (count: number) => recording.lines.slice(0, count).join("");
  const facts = (file: string) => ({
    transcriptPath: file,
    lastMessage: stop.text,
    promptId: stop.promptId,
  });

  test("the summary's line half written: not yet; whole: continuing", () => {
    const file = join(dir, "partial.jsonl");
    const line = recording.lines[summary] ?? "";
    const half = Math.floor(line.length / 2);
    writeFileSync(file, upTo(summary) + line.slice(0, half));
    const read = () => classifyEntries(readTail(file, 2_000_000), stop.text.trim(), stop.promptId);
    expect(read()).toBeUndefined();
    appendFileSync(file, line.slice(half));
    expect(read()?.outcome).toBe("continuing");
  });

  test("the summary written before the waiter started: found at once", async () => {
    const file = join(dir, "before.jsonl");
    writeFileSync(file, upTo(summary + 1));
    expect(await classifyStop(facts(file), { timeoutMs: 0 })).toMatchObject({
      outcome: "continuing",
    });
  });

  test("the summary written while the waiter waits: found then", async () => {
    const file = join(dir, "later.jsonl");
    writeFileSync(file, upTo(stop.entriesAtStart));
    const result = classifyStop(facts(file), { timeoutMs: 5000, pollMs: 20 });
    await Bun.sleep(100);
    appendFileSync(file, recording.lines.slice(stop.entriesAtStart, summary + 1).join(""));
    expect((await result).outcome).toBe("continuing");
  });
});
