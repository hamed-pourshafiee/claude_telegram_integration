import { closeSync, existsSync, openSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { errorCode } from "./errors.ts";
import { asFields } from "./json.ts";
import { type Log, noLog } from "./log.ts";
import { BROKER_MAIN, BUNFIG_FILE, REPO_ROOT, type StatePaths } from "./paths.ts";
import { ensureStateDir, isDisabled } from "./state.ts";

/** The broker's answer to /health. */
export interface BrokerHealth {
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  /** The public part of the token it uses: the bot's user id. */
  readonly botId: number;
  /** Secret.fingerprint() of the token it uses. */
  readonly tokenFingerprint: string;
  readonly schema: number;
  /** The names of its environment variables, which should be only those of brokerEnv(). */
  readonly envKeys: readonly string[];
}

/** How to start a broker: a Bun binary, the entry file and the bunfig.toml to load (F14). */
export interface BrokerLaunch {
  readonly bun: string;
  readonly main: string;
  readonly bunfig: string;
  readonly cwd: string;
}

/** This repo's broker, started with the Bun that runs the caller. */
export const BROKER_LAUNCH: BrokerLaunch = {
  bun: process.execPath,
  main: BROKER_MAIN,
  bunfig: BUNFIG_FILE,
  cwd: REPO_ROOT,
};

export type BrokerState = "running" | "started" | "disabled" | "failed";

/** The broker's /health, or undefined when none answers in time. */
export async function brokerHealth(
  paths: StatePaths,
  log: Log,
  timeoutMs = 1000,
): Promise<BrokerHealth | undefined> {
  return parseHealth(await request(paths, "/health", undefined, log, timeoutMs));
}

/** POSTs `body` to the broker: its JSON answer, or undefined when it didn't answer. */
export function callBroker(
  paths: StatePaths,
  path: string,
  body: unknown,
  log: Log,
  timeoutMs = 2000,
): Promise<unknown> {
  return request(paths, path, JSON.stringify(body), log, timeoutMs);
}

/**
 * Makes sure a broker runs (D3): starts one unless one answers or the disabled flag is set. Callers
 * that race may each start one; the single-instance lock keeps exactly one.
 */
export async function ensureBroker(
  paths: StatePaths,
  launch: BrokerLaunch,
  log: Log,
  waitMs = 3000,
): Promise<BrokerState> {
  if (isDisabled(paths)) return "disabled";
  if (await brokerHealth(paths, log)) return "running";
  spawnBroker(paths, launch);
  log("broker.spawned", {});
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    if (await brokerHealth(paths, noLog, 500)) return "started";
  }
  log("broker.start-failed", { waitedMs: waitMs });
  return "failed";
}

/**
 * Starts a broker in a session of its own (setsid), so it outlives the hook that started it, with
 * brokerEnv() as its whole environment. Its stderr goes to .state/logs/broker.stderr.log.
 */
export function spawnBroker(paths: StatePaths, launch: BrokerLaunch): void {
  ensureStateDir(paths);
  const stderr = openSync(join(paths.logs, "broker.stderr.log"), "a", 0o600);
  try {
    const child = Bun.spawn({
      cmd: [launch.bun, "--no-env-file", `--config=${launch.bunfig}`, launch.main],
      cwd: launch.cwd,
      env: brokerEnv(),
      detached: true,
      stdio: ["ignore", "ignore", stderr],
    });
    child.unref();
  } finally {
    closeSync(stderr);
  }
}

/**
 * The broker's whole environment (D3). Nothing comes from the session that started it, so a variable
 * such as BUN_CONFIG_VERBOSE_FETCH or NODE_OPTIONS never reaches the process that holds the token.
 */
export function brokerEnv(): Record<string, string> {
  const { homedir, username } = userInfo();
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir,
    USER: username,
    LOGNAME: username,
  };
}

async function request(
  paths: StatePaths,
  path: string,
  body: string | undefined,
  log: Log,
  timeoutMs: number,
): Promise<unknown> {
  if (!existsSync(paths.socket)) return undefined;
  const init = body === undefined ? {} : { method: "POST", body, headers: JSON_HEADERS };
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`http://broker${path}`, { ...init, unix: paths.socket, signal });
    return await response.json();
  } catch (error) {
    // No broker is listening (a socket left by a crash, say) or it answered badly: the caller treats
    // it as "no broker" and may start one.
    log("broker.unreachable", { path, error: errorCode(error) });
    return undefined;
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

function parseHealth(value: unknown): BrokerHealth | undefined {
  const fields = asFields(value);
  if (fields?.ok !== true) return undefined;
  const { pid, startedAt, uptimeSeconds, botId, tokenFingerprint, schema, envKeys } = fields;
  if (
    typeof pid !== "number" ||
    typeof startedAt !== "string" ||
    typeof uptimeSeconds !== "number" ||
    typeof botId !== "number" ||
    typeof tokenFingerprint !== "string" ||
    typeof schema !== "number" ||
    !Array.isArray(envKeys)
  ) {
    return undefined;
  }
  const keys: readonly unknown[] = envKeys;
  const names = keys.filter((key): key is string => typeof key === "string");
  return { pid, startedAt, uptimeSeconds, botId, tokenFingerprint, schema, envKeys: names };
}
