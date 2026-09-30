import { errorCode } from "./errors.ts";
import type { Log } from "./log.ts";
import { readTail } from "./transcript.ts";

/** How much of the transcript's end is read: Claude Code writes the title there again every few turns. */
const TITLE_TAIL_BYTES = 512_000;

/**
 * The session's title as Claude Code shows it (F21, plan 7.2): the one you gave it (custom-title), else
 * the one it made (ai-title), each the latest in the transcript's end. Undefined while it has none, as
 * in a new session's first turn, or when the transcript can't be read (logged, unless it isn't there yet).
 * Hooks read it at each call, and the broker when it lists the sessions (plan 7.5).
 */
export function sessionTitle(
  transcriptPath: string | undefined,
  log: Log,
  bytes = TITLE_TAIL_BYTES,
): string | undefined {
  if (!transcriptPath) return undefined;
  let entries: ReturnType<typeof readTail>;
  try {
    entries = readTail(transcriptPath, bytes);
  } catch (error) {
    // A session's first hook can come before its transcript exists.
    if (errorCode(error) !== "ENOENT") log("title.unreadable", { error: errorCode(error) });
    return undefined;
  }
  let custom = "";
  let made = "";
  for (const entry of entries) {
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      custom = entry.customTitle.trim();
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") made = entry.aiTitle.trim();
  }
  return custom || made || undefined;
}
