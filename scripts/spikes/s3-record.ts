// Spike S3 (implementation-plan 1.4): record real hook inputs as test fixtures. Throwaway. Sessions
// outside <repo>/sandbox/ exit 0 at once, before any file access. Inside, each event's stdin is saved,
// redacted, to .state/spikes/s3/<entrypoint>/<time>-<event>[-<detail>].json together with the
// entrypoint and how long this process had run; a summary line goes to .state/spikes/s3.log.
// It never prints anything, so it never makes a decision.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendLog,
  asObject,
  isInside,
  type JsonObject,
  readHookInput,
  SANDBOX_DIR,
  SPIKE_DIR,
} from "./lib.ts";

const LOG = "s3.log";
const MAX_STRING = 4000;
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Telegram bot token. No \b: in API URLs it follows "bot" directly (…/bot123:ABC…), and it may end in "-".
  /(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{30,}/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

/**
 * A copy of `value` with the home path shortened to "~", secrets masked and long strings capped.
 * Keys are redacted too: some are user text, e.g. AskUserQuestion answers are keyed by the question.
 */
export function redact(value: unknown, home: string): unknown {
  if (typeof value === "string") return redactString(value, home);
  if (Array.isArray(value)) return value.map((item) => redact(item, home));
  const object = asObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([k, v]) => [redactString(k, home), redact(v, home)]),
  );
}

function redactString(text: string, home: string): string {
  const user = home.split("/").pop() ?? "";
  let out = text.split(home).join("~");
  if (user) out = out.split(`-Users-${user}-`).join("-Users-USER-");
  for (const pattern of SECRETS) out = out.replace(pattern, "[REDACTED]");
  return out.length > MAX_STRING
    ? `${out.slice(0, MAX_STRING)}…[+${out.length - MAX_STRING} chars]`
    : out;
}

/** What tells two inputs of one event apart: notification type, tool, start source or end reason. */
export function detailOf(input: JsonObject): string {
  const detail = input.notification_type ?? input.tool_name ?? input.source ?? input.reason;
  return typeof detail === "string" ? detail.replace(/[^A-Za-z0-9_-]/g, "") : "";
}

async function main(): Promise<void> {
  const input = await readHookInput();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!isInside(cwd, SANDBOX_DIR)) return;

  const entrypoint = (process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown").replace(
    /[^A-Za-z0-9_-]/g,
    "",
  );
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "unknown";
  const detail = detailOf(input);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(SPIKE_DIR, "s3", entrypoint);
  const file = join(dir, `${stamp}-${process.pid}-${event}${detail ? `-${detail}` : ""}.json`);
  // Does CLAUDE_PROJECT_DIR stay where the session started when it cd's elsewhere? (scoping, 1.5)
  const projectDir = redact(process.env.CLAUDE_PROJECT_DIR ?? null, homedir());
  const fixture = {
    recordedAt: new Date().toISOString(),
    entrypoint,
    projectDir,
    input: redact(input, homedir()),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  appendLog(LOG, {
    session: typeof input.session_id === "string" ? input.session_id : "unknown",
    entrypoint,
    event,
    detail,
    file: file.slice(SPIKE_DIR.length + 1),
    projectDir,
    processMs: Math.round(Date.now() - performance.timeOrigin),
  });
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    logFailure("unhandledRejection", reason);
    process.exit(0);
  });
  main().catch((error: unknown) => {
    logFailure("main", error);
    process.exitCode = 0; // fail safe: no output, no decision (design D5)
  });
}

function logFailure(where: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    appendLog(LOG, { event: "error", where, message, pid: process.pid });
  } catch (logError) {
    process.stderr.write(`s3 spike: ${where}: ${message} (log failed: ${String(logError)})\n`);
  }
}
