// Spike S1 (implementation-plan 1.2): can an asyncRewake Stop hook wake an idle VS Code session?
// Throwaway. Sessions outside <repo>/sandbox/ exit 0 at once, before any file access. Inside, it
// waits `delaySeconds`, then exits 2 with the PONG instruction, at most `maxWakes` times per session
// since .state/spikes/s1.json last changed (rewrite that file to start a new run; defaults 60 s, 1).
// Events go to .state/spikes/s1.log as JSON lines: ids, sizes and process facts, never message text.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appendLog,
  asObject,
  commandName,
  isInside,
  type JsonObject,
  processStats,
  readHookInput,
  SANDBOX_DIR,
  SPIKE_DIR,
} from "./lib.ts";

const LOG = "s1.log";
const CONTROL = join(SPIKE_DIR, "s1.json");
const HEARTBEAT_MS = 15_000;
const REMINDER = "SPIKE: reply with the word PONG";

interface Control {
  delaySeconds: number;
  maxWakes: number;
  sinceMs: number;
}

function readControl(): Control {
  if (!existsSync(CONTROL)) return { delaySeconds: 60, maxWakes: 1, sinceMs: 0 };
  const raw = asObject(JSON.parse(readFileSync(CONTROL, "utf8")));
  const count = (key: string, fallback: number): number => {
    const value = raw?.[key];
    return typeof value === "number" && value >= 0 ? value : fallback;
  };
  return {
    delaySeconds: count("delaySeconds", 60),
    maxWakes: count("maxWakes", 1),
    sinceMs: statSync(CONTROL).mtimeMs,
  };
}

function wakesSince(session: string, sinceMs: number): number {
  const file = join(SPIKE_DIR, LOG);
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const record = line ? asObject(JSON.parse(line)) : undefined;
      if (record?.event !== "wake" || record.session !== session) return false;
      return typeof record.t === "string" && Date.parse(record.t) >= sinceMs;
    }).length;
}

function describeInput(input: JsonObject): JsonObject {
  const message = input.last_assistant_message;
  const tasks = input.background_tasks;
  return {
    keys: Object.keys(input).sort(),
    hookEvent: input.hook_event_name ?? null,
    stopHookActive: input.stop_hook_active ?? null,
    backgroundTasks: Array.isArray(tasks) ? tasks.length : typeof tasks,
    lastMessageChars: typeof message === "string" ? message.length : null,
    permissionMode: input.permission_mode ?? null,
  };
}

async function waitWithHeartbeat(seconds: number, base: JsonObject): Promise<void> {
  const end = Date.now() + seconds * 1000;
  for (let left = end - Date.now(); left > 0; left = end - Date.now()) {
    await Bun.sleep(Math.min(HEARTBEAT_MS, left));
    appendLog(LOG, { ...base, event: "heartbeat", ...processStats(process.pid) });
  }
}

function watchSignals(base: JsonObject): void {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => {
      appendLog(LOG, { ...base, event: "signal", signal });
      process.exit(0); // leave with no decision (design D5)
    });
  }
}

async function main(): Promise<number> {
  const input = await readHookInput();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!isInside(cwd, SANDBOX_DIR)) return 0;

  const session = typeof input.session_id === "string" ? input.session_id : "unknown";
  const base = { session, pid: process.pid };
  const control = readControl();
  watchSignals(base);
  appendLog(LOG, {
    ...base,
    event: "start",
    ...describeInput(input),
    ...processStats(process.pid),
    parent: commandName(process.ppid),
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    control,
  });
  if (wakesSince(session, control.sinceMs) < control.maxWakes) {
    await waitWithHeartbeat(control.delaySeconds, base);
  }
  // Checked again after the wait: another hook of this session may have woken it meanwhile.
  if (wakesSince(session, control.sinceMs) >= control.maxWakes) {
    appendLog(LOG, { ...base, event: "skip", reason: "maxWakes reached" });
    return 0;
  }
  appendLog(LOG, { ...base, event: "wake", ...processStats(process.pid) });
  process.stderr.write(`${REMINDER}\n`);
  return 2;
}

function logFailure(where: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    appendLog(LOG, { event: "error", where, message, pid: process.pid });
  } catch (logError) {
    process.stderr.write(`s1 spike: ${where}: ${message} (log failed: ${String(logError)})\n`);
  }
}

process.on("unhandledRejection", (reason) => {
  logFailure("unhandledRejection", reason);
  process.exit(0);
});

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logFailure("main", error);
    process.exitCode = 0; // fail safe: no decision (design D5)
  },
);
