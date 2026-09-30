import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** A log past this size is rotated: 5 MB holds a few weeks of the broker's. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** How many rotated copies of each log are kept: <name>.log.1, the newest, to .3. */
export const KEEP_LOGS = 3;

/**
 * Rotates each *.log in `dir` that has grown past `maxBytes` (plan 6.1): <name>.log.2 becomes .3, .1
 * becomes .2, the log becomes .1, and the oldest copy past `keep` goes. Writers append by path, so
 * their next line starts a new file (0600, as fileLog makes it). Only the broker rotates, so two
 * rotations never race. Returns the names of the logs rotated.
 */
export function rotateLogs(dir: string, maxBytes = MAX_LOG_BYTES, keep = KEEP_LOGS): string[] {
  const rotated: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (!name.endsWith(".log") || statSync(file).size <= maxBytes) continue;
    for (let n = keep; n >= 1; n -= 1) {
      const from = n === 1 ? file : `${file}.${n - 1}`;
      if (existsSync(from)) renameSync(from, `${file}.${n}`);
    }
    rotated.push(name);
  }
  return rotated;
}
