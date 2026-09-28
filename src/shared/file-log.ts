import { appendFileSync } from "node:fs";
import { messageOf } from "./errors.ts";
import type { Log } from "./log.ts";

/**
 * A Log that appends one JSON line per event to `file` (0600). A log that can't be written must not
 * break a hook (D5), so the first failure is reported on stderr instead of thrown.
 */
export function fileLog(file: string, source: string): Log {
  let reported = false;
  return (event, fields) => {
    const entry = { ...fields, t: new Date().toISOString(), source, pid: process.pid, event };
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      if (reported) return;
      reported = true;
      console.error(`${source}: cannot write ${file}: ${messageOf(error)}`);
    }
  };
}
