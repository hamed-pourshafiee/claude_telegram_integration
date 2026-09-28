// Every hook event runs this (design §3):
//   bun --no-env-file --config=<repo>/bunfig.toml <repo>/src/hooks/main.ts <event>
// It fails safe (D5): on any error it logs and exits 0 with no output, so Claude carries on as if the
// hook weren't there. Plan 2.3: a served session's hook makes sure the broker runs and reports to it;
// the events get their own jobs from plan 2.7 on.
import { join } from "node:path";
import { BROKER_LAUNCH, callBroker, ensureBroker } from "../shared/broker-client.ts";
import { loadConfig } from "../shared/config.ts";
import { messageOf } from "../shared/errors.ts";
import { fileLog } from "../shared/file-log.ts";
import { asFields } from "../shared/json.ts";
import { CONFIG_FILE, HOME_DIR, REPO_ROOT, STATE } from "../shared/paths.ts";
import { sessionEnv, sessionScope } from "../shared/scope.ts";
import { isDisabled } from "../shared/state.ts";
import { refuseVerboseFetch } from "../shared/telegram/errors.ts";

const log = fileLog(join(STATE.logs, "hooks.log"), "hook");

process.on("unhandledRejection", (reason) => {
  log("hook.crash", { error: messageOf(reason) });
  process.exit(0);
});

async function main(event: string): Promise<void> {
  if (isDisabled(STATE) || !/^[A-Za-z]{1,40}$/.test(event)) return;
  // Verbose fetch would print our requests to stdout, which Claude reads as the hook's output.
  refuseVerboseFetch(process.env);
  const session = await readSessionId(event);
  if (session === undefined) return;
  const config = loadConfig(CONFIG_FILE, { repoRoot: REPO_ROOT, home: HOME_DIR });
  const env = sessionEnv(process.env);
  if (!sessionScope(config, env).served) return;
  const state = await ensureBroker(STATE, BROKER_LAUNCH, log);
  if (state !== "running" && state !== "started") return;
  const body = { session_id: session, entrypoint: env.entrypoint ?? "" };
  await callBroker(STATE, `/hook/${event}`, body, log);
}

/** The session_id from the hook's input on stdin. Only sizes are logged: the input holds Claude's text. */
async function readSessionId(event: string): Promise<string | undefined> {
  const text = await Bun.stdin.text();
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    log("hook.bad-input", { hook: event, bytes: text.length, reason: "not JSON" });
    return undefined;
  }
  const session = asFields(input)?.session_id;
  if (typeof session === "string" && session !== "") return session;
  log("hook.bad-input", { hook: event, bytes: text.length, reason: "no session_id" });
  return undefined;
}

try {
  await main(Bun.argv[2] ?? "");
} catch (error) {
  log("hook.failed", { hook: Bun.argv[2] ?? "", error: messageOf(error) });
}
process.exitCode = 0;
