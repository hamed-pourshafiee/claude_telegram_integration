import { errorCode } from "./errors.ts";

/** Whether a process runs: a signal-0 kill, where EPERM means it runs as another user. */
export function processAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
