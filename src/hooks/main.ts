// Every hook event runs this (design §3):
//   bun --no-env-file --config=<repo>/bunfig.toml <repo>/src/hooks/main.ts <event> [--wait]
// It fails safe (D5): on any error it logs and exits 0, so Claude carries on as if the hook weren't
// there. The only other exit is 2, a Stop hook waking Claude with a Telegram reply (F2). Only hooks
// installed with --wait wait: the Stop hook (asyncRewake) for a reply, the question hook for your
// answers, which it prints for Claude (F4). It acts only for served sessions, decided by where the
// session started (F15), never inside a subagent; each event's job is in events.ts.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BROKER_LAUNCH, callBroker, ensureBroker } from "../shared/broker-client.ts";
import { loadConfig } from "../shared/config.ts";
import { messageOf } from "../shared/errors.ts";
import { fileLog } from "../shared/file-log.ts";
import { type HookInput, parseHookInput } from "../shared/hook-input.ts";
import { CONFIG_FILE, HOME_DIR, REPO_ROOT, STATE } from "../shared/paths.ts";
import { writePending } from "../shared/pending.ts";
import { processAlive } from "../shared/process.ts";
import { sessionEnv, sessionScope } from "../shared/scope.ts";
import { isDisabled } from "../shared/state.ts";
import { refuseVerboseFetch } from "../shared/telegram/errors.ts";
import { HANDLERS } from "./events.ts";

const log = fileLog(join(STATE.logs, "hooks.log"), "hook");
const [event = "", ...flags] = Bun.argv.slice(2);
/** Its parent: hooks run as direct children of the Claude Code process (probed in plan 3.1). */
const claudePid = process.ppid;
/** SIGTERM (the panel closed, the hook's timeout) aborts a wait, which then reports its end. */
const terminated = new AbortController();
let exitCode = 0;

process.on("unhandledRejection", (reason) => {
  log("hook.crash", { error: messageOf(reason) });
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("hook.terminated", { hook: event });
  terminated.abort();
});

async function main(): Promise<void> {
  const handler = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : undefined;
  if (handler === undefined || isDisabled(STATE)) return;
  // Verbose fetch would print our requests to stdout, which Claude reads as the hook's output.
  refuseVerboseFetch(process.env);
  const input = await readInput(event);
  // Subagents are skipped (plan 2.7): their stops and questions belong to the main thread's turn.
  if (input === undefined || input.agentId !== undefined) return;
  const config = loadConfig(CONFIG_FILE, { repoRoot: REPO_ROOT, home: HOME_DIR });
  const env = sessionEnv(process.env);
  if (!sessionScope(config, env).served || env.projectDir === undefined) return;
  const session = {
    session_id: input.sessionId,
    project_dir: realpathSync(env.projectDir),
    entrypoint: env.entrypoint ?? "",
  };
  await handler({
    input,
    session,
    log,
    ensureBroker: async () => {
      const state = await ensureBroker(STATE, BROKER_LAUNCH, log);
      return state === "running" || state === "started";
    },
    call: (name, body, timeoutMs, signal) =>
      callBroker(STATE, `/hook/${name}`, body, log, timeoutMs, signal),
    print: (text) => {
      process.stdout.write(`${text}\n`);
    },
    wait: flags.includes("--wait"),
    signal: terminated.signal,
    rewake: (text) => {
      process.stderr.write(`${text}\n`);
      exitCode = 2;
    },
    claudePid,
    claudeAlive: () => process.ppid === claudePid && processAlive(claudePid),
    disabled: () => isDisabled(STATE),
    pending: (item) => writePending(STATE, item),
  });
}

/** The hook's input from stdin. Only sizes are logged: the input holds Claude's text. */
async function readInput(event: string): Promise<HookInput | undefined> {
  const text = await Bun.stdin.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    log("hook.bad-input", { hook: event, bytes: text.length, reason: "not JSON" });
    return undefined;
  }
  const input = parseHookInput(value);
  if (input === undefined) {
    log("hook.bad-input", { hook: event, bytes: text.length, reason: "no session_id" });
  }
  return input;
}

try {
  await main();
} catch (error) {
  exitCode = 0;
  log("hook.failed", { hook: event, error: messageOf(error) });
}
process.exit(exitCode);
