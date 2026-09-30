import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { errorCode } from "../shared/errors.ts";
import { asFields, type Fields } from "../shared/json.ts";
import { pause } from "../shared/pause.ts";

/** How a stop ended (flow 1): a real finish, Claude going on because a hook said so, or unknown. */
export type StopOutcome = "finish" | "continuing" | "unknown";

export interface Classification {
  readonly outcome: StopOutcome;
  /** Which rule decided, for the log. */
  readonly reason: string;
  /** The Claude Code version in the stop's summary, for ctl doctor (plan 6.1). */
  readonly version?: string;
}

export interface StopFacts {
  readonly transcriptPath: string | undefined;
  readonly lastMessage: string | undefined;
  readonly promptId: string | undefined;
}

export interface ClassifyOptions {
  /** How long to wait for the stop's summary; default 30 s (flow 1). */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** How much of the transcript's end to read; default 2 MB. */
  readonly tailBytes?: number;
  readonly signal?: AbortSignal;
}

/** The entries with which Claude Code continues a turn (F16). */
const CONTINUATIONS: ReadonlySet<string> = new Set([
  "hook_blocking_error",
  "hook_additional_context",
]);
/** Entries between a stop's assistant entry and its summary: a few in practice. */
const MAX_PATH = 20;

/**
 * Reads the transcript's end until this stop's summary is there, then classifies the stop (F16). A
 * summary written before this hook started is found too. No summary within the time, or no transcript,
 * is "unknown", which sends nothing (D5).
 */
export async function classifyStop(
  facts: StopFacts,
  options: ClassifyOptions = {},
): Promise<Classification> {
  const { transcriptPath, lastMessage, promptId } = facts;
  if (!transcriptPath) return { outcome: "unknown", reason: "no transcript path" };
  const text = lastMessage?.trim() ?? "";
  if (text === "") return { outcome: "unknown", reason: "no last assistant message" };
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  do {
    let entries: Fields[];
    try {
      entries = readTail(transcriptPath, options.tailBytes ?? 2_000_000);
    } catch (error) {
      return { outcome: "unknown", reason: `transcript unreadable: ${errorCode(error)}` };
    }
    const result = classifyEntries(entries, text, promptId);
    if (result !== undefined) return result;
    await pause(options.pollMs ?? 200, options.signal);
  } while (Date.now() < deadline && options.signal?.aborted !== true);
  return { outcome: "unknown", reason: "no summary in time" };
}

/**
 * The stop's outcome from transcript entries, or undefined while its summary isn't written. The stop's
 * assistant entry is the latest whose message text is `text` and whose turn is `promptId`; the first
 * stop_hook_summary below it closes the stop. A continuation entry on the way means Claude goes on,
 * unless the summary has preventedContinuation; anything else, a hook's crash included, is a finish.
 */
export function classifyEntries(
  entries: readonly Fields[],
  text: string,
  promptId: string | undefined,
): Classification | undefined {
  const byUuid = new Map<string, Fields>();
  const children = new Map<string, Fields[]>();
  for (const entry of entries) {
    const uuid = str(entry.uuid);
    if (uuid !== undefined) byUuid.set(uuid, entry);
    const parent = str(entry.parentUuid);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const stop = stopEntry(entries, byUuid, text, promptId);
  const path = stop === undefined ? undefined : pathToSummary(stop, children);
  if (path === undefined) return undefined;
  const version = str(path.at(-1)?.version);
  const seen = version === undefined ? {} : { version };
  const continued = path.some((entry) => CONTINUATIONS.has(attachmentType(entry) ?? ""));
  if (!continued) return { outcome: "finish", reason: "no continuation entry", ...seen };
  if (path.at(-1)?.preventedContinuation === true) {
    return { outcome: "finish", reason: "continuation prevented", ...seen };
  }
  return { outcome: "continuing", reason: "continuation entry", ...seen };
}

/** The latest assistant entry that ends a message with this text, in the turn of `promptId`. */
function stopEntry(
  entries: readonly Fields[],
  byUuid: ReadonlyMap<string, Fields>,
  text: string,
  promptId: string | undefined,
): Fields | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "assistant" || messageText(entries, index) !== text) continue;
    const turn = promptOf(entry, byUuid);
    // A turn out of reach of the tail can't be checked; the text match stands.
    if (promptId === undefined || turn === undefined || turn === promptId) return entry;
  }
  return undefined;
}

/** The text of the message that entries[index] ends: its text blocks, which Claude Code may split. */
function messageText(entries: readonly Fields[], index: number): string {
  const id = str(asFields(entries[index]?.message)?.id);
  const parts: string[] = [];
  for (let at = index; at >= 0; at -= 1) {
    const entry = entries[at];
    const message = asFields(entry?.message);
    if (entry?.type !== "assistant" || (at !== index && str(message?.id) !== id)) break;
    parts.unshift(...textBlocks(message?.content));
    if (id === undefined) break;
  }
  return parts.join("\n").trim();
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const blocks: readonly unknown[] = content;
  return blocks.flatMap((block) => {
    const fields = asFields(block);
    return fields?.type === "text" && typeof fields.text === "string" ? [fields.text] : [];
  });
}

/** The promptId of the user entry nearest above `entry`: the prompt this turn answers. */
function promptOf(entry: Fields, byUuid: ReadonlyMap<string, Fields>): string | undefined {
  let current: Fields | undefined = entry;
  for (let steps = 0; current !== undefined && steps < 10_000; steps += 1) {
    const promptId = current.type === "user" ? str(current.promptId) : undefined;
    if (promptId !== undefined) return promptId;
    const parent = str(current.parentUuid);
    current = parent === undefined ? undefined : byUuid.get(parent);
  }
  return undefined;
}

/** The entries from `start` down to the first stop_hook_summary, or undefined if none is there yet. */
function pathToSummary(
  start: Fields,
  children: ReadonlyMap<string, Fields[]>,
): Fields[] | undefined {
  let level: { readonly entry: Fields; readonly path: Fields[] }[] = [{ entry: start, path: [] }];
  for (let depth = 0; depth < MAX_PATH && level.length > 0; depth += 1) {
    const next: typeof level = [];
    for (const { entry, path } of level) {
      for (const child of children.get(str(entry.uuid) ?? "") ?? []) {
        const route = [...path, child];
        if (child.type === "system" && child.subtype === "stop_hook_summary") return route;
        // The next assistant entry belongs to a later stop.
        if (child.type !== "assistant") next.push({ entry: child, path: route });
      }
    }
    level = next;
  }
  return undefined;
}

function attachmentType(entry: Fields): string | undefined {
  return entry.type === "attachment" ? str(asFields(entry.attachment)?.type) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The JSON entries in the last `bytes` of a JSONL file. A line cut at the start of the window, or a
 * partial last line still being written, is skipped.
 */
export function readTail(path: string, bytes: number): Fields[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.flatMap((line) => parseLine(line));
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): Fields[] {
  if (line.trim() === "") return [];
  try {
    const entry = asFields(JSON.parse(line));
    return entry === undefined ? [] : [entry];
  } catch {
    return []; // a partial line: the next read has it whole
  }
}
