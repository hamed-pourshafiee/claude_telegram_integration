// The stops recorded by scripts/record-stops.ts (plan 2.8): real transcripts, cut down to what the
// classifier reads, with each stop as its hooks saw it. The truth is what Claude Code did: a stop was
// a real finish exactly when no other stop of its prompt came after it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Classification, classifyEntries } from "../../src/hooks/finish.ts";
import type { Fields } from "../../src/shared/json.ts";

export interface RecordedStop {
  /** 1 for the session's first prompt, 2 for the next. */
  readonly prompt: number;
  readonly promptId?: string;
  /** The Stop input's last_assistant_message. */
  readonly text: string;
  /** Complete transcript lines when the stop's hooks started. */
  readonly entriesAtStart: number;
  readonly truth: "finish" | "continuing";
}

export interface Recording {
  readonly version: string;
  readonly scenario: string;
  readonly entries: readonly Fields[];
  /** The fixture's lines, each with its "\n". */
  readonly lines: readonly string[];
  readonly stops: readonly RecordedStop[];
}

/** What Claude Code did in each scenario, stop by stop, as scripts/record-stops.ts sets it up. */
export const EXPECTED: Readonly<Record<string, readonly RecordedStop["truth"][]>> = {
  block: ["continuing", "finish"],
  "block-twice": ["continuing", "continuing", "finish"],
  context: ["continuing", "finish"],
  crash: ["finish"],
  prevented: ["finish"],
  "same-text": ["finish", "finish"],
  "same-text-block": ["continuing", "finish", "continuing", "finish"],
};

const ROOT = join(import.meta.dir, "..", "fixtures", "transcripts");

function load(version: string, scenario: string): Recording {
  const base = join(ROOT, version, scenario);
  const facts: { stops: RecordedStop[] } = JSON.parse(readFileSync(`${base}.json`, "utf8"));
  const text = readFileSync(`${base}.jsonl`, "utf8");
  const lines = text.split("\n").flatMap((line) => (line === "" ? [] : [`${line}\n`]));
  const entries = lines.map((line): Fields => JSON.parse(line));
  return { version, scenario, entries, lines, stops: facts.stops };
}

/** Every recording, each Claude Code version's folder in turn. */
export const RECORDINGS: readonly Recording[] = readdirSync(ROOT).flatMap((version) =>
  readdirSync(join(ROOT, version))
    .filter((file) => file.endsWith(".json"))
    .map((file) => load(version, file.slice(0, -".json".length))),
);

export const named = (recording: Recording): string => `${recording.version} ${recording.scenario}`;

/** Where the stop's summary is: the first one after the entries its hook saw when it started. */
export function summaryAt(recording: Recording, stop: RecordedStop): number {
  const index = recording.entries.findIndex(
    (entry, at) =>
      at >= stop.entriesAtStart && entry.type === "system" && entry.subtype === "stop_hook_summary",
  );
  if (index < 0) throw new Error(`${named(recording)}: no summary after ${stop.entriesAtStart}`);
  return index;
}

/** The stop classified from the transcript's first `count` entries. */
export function classifiedAt(
  recording: Recording,
  stop: RecordedStop,
  count: number,
): Classification | undefined {
  return classifyEntries(recording.entries.slice(0, count), stop.text.trim(), stop.promptId);
}
