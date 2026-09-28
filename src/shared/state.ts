import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { StatePaths } from "./paths.ts";

/** Creates .state/ and .state/logs/ (0700), and tightens them if they were looser (design §5). */
export function ensureStateDir(paths: StatePaths): void {
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  chmodSync(paths.logs, 0o700);
}

/** The persistent disabled flag (D3): while it is set, hooks do nothing and nothing starts the broker. */
export function isDisabled(paths: StatePaths): boolean {
  return existsSync(paths.disabled);
}

export function setDisabled(paths: StatePaths, disabled: boolean): void {
  if (!disabled) {
    rmSync(paths.disabled, { force: true });
    return;
  }
  ensureStateDir(paths);
  writeFileSync(paths.disabled, `disabled at ${new Date().toISOString()}\n`, { mode: 0o600 });
}
