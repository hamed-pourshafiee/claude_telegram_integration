import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { asFields } from "./json.ts";
import type { StatePaths } from "./paths.ts";

/** You typed at the Mac at `at` (ms since the epoch) while no broker answered (flow 2). */
export interface PendingCancel {
  readonly kind: "cancel";
  readonly sessionId: string;
  readonly at: number;
}

/** A waiter stopped while no broker answered (SIGTERM, plan 3.1). */
export interface PendingEnd {
  readonly kind: "end";
  readonly sessionId: string;
  readonly generation: number;
  readonly at: number;
}

export type Pending = PendingCancel | PendingEnd;

/** A written item and its file, which is removed once the broker has applied it. */
export interface PendingFile {
  readonly item: Pending;
  readonly file: string;
}

/**
 * Writes what a hook couldn't tell the broker into .state/pending/ (0700, files 0600), in one rename so
 * the broker never reads half a file. The next broker applies these before it takes replies.
 */
export function writePending(paths: StatePaths, item: Pending): void {
  mkdirSync(paths.pending, { recursive: true, mode: 0o700 });
  chmodSync(paths.pending, 0o700);
  const name = `${item.kind}-${item.at}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const temp = join(paths.pending, `.${name}.tmp`);
  writeFileSync(temp, JSON.stringify(item), { mode: 0o600 });
  renameSync(temp, join(paths.pending, `${name}.json`));
}

/** The pending items, oldest first. A file that can't be read or parsed is skipped and left there. */
export function readPending(paths: StatePaths, onBad: (file: string) => void): PendingFile[] {
  if (!existsSync(paths.pending)) return [];
  const files = readdirSync(paths.pending).filter((name) => /^[a-z]+-\d+-.*\.json$/.test(name));
  const items = files.flatMap((name): PendingFile[] => {
    const file = join(paths.pending, name);
    const item = parsePending(readText(file));
    if (item === undefined) {
      onBad(file);
      return [];
    }
    return [{ item, file }];
  });
  return items.sort((a, b) => a.item.at - b.item.at);
}

export function removePending(entry: PendingFile): void {
  rmSync(entry.file, { force: true });
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return ""; // gone meanwhile or unreadable: parsePending rejects "" and the caller logs the file
  }
}

function parsePending(text: string): Pending | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined; // not JSON: the caller logs it as a bad file
  }
  const fields = asFields(value);
  const { kind, sessionId, at, generation } = fields ?? {};
  if (typeof sessionId !== "string" || sessionId === "" || typeof at !== "number") return undefined;
  if (kind === "cancel") return { kind, sessionId, at };
  if (kind === "end" && typeof generation === "number") return { kind, sessionId, generation, at };
  return undefined;
}
