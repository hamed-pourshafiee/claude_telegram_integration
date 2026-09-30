import { closeSync, existsSync, openSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { errorCode } from "./errors.ts";
import { asFields } from "./json.ts";
import { type Log, noLog } from "./log.ts";
import { BROKER_LAUNCHER, BROKER_MAIN, BUNFIG_FILE, REPO_ROOT, type StatePaths } from "./paths.ts";
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
  /** The paired Telegram user's name, or null before pairing (plan 2.4). */
  readonly paired: string | null;
  /** When the pending pairing code expires, or null. */
  readonly pairingUntil: string | null;
  /** Whether it polls Telegram, which it does once someone is paired or a pairing is pending. */
  readonly polling: boolean;
  /** Where the bridge thinks you are (plan 2.6); missing from a broker older than that. */
  readonly presence?: PresenceHealth;
}

/** Presence in /health: a null value is one ioreg didn't give. */
export interface PresenceHealth {
  readonly mode: string;
  readonly state: string;
  readonly because: string;
  readonly idleSeconds: number | null;
  readonly locked: boolean | null;
}

/**
 * How to start a broker: a Bun binary, the entry file and the bunfig.toml to load (F14), and the
 * launcher that starts it and exits (plan 7.6).
 */
export interface BrokerLaunch {
  readonly bun: string;
  readonly main: string;
  readonly launcher: string;
  readonly bunfig: string;
  readonly cwd: string;
}

/** This repo's broker, started with the Bun that runs the caller. */
export const BROKER_LAUNCH: BrokerLaunch = {
  bun: process.execPath,
  main: BROKER_MAIN,
  launcher: BROKER_LAUNCHER,
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

/**
 * POSTs `body` to the broker: its JSON answer, or undefined when it didn't answer in time or `signal`
 * aborted the call (a waiting hook's SIGTERM, plan 3.1).
 */
export function callBroker(
  paths: StatePaths,
  path: string,
  body: unknown,
  log: Log,
  timeoutMs = 2000,
  signal?: AbortSignal,
): Promise<unknown> {
  return request(paths, path, JSON.stringify(body), log, timeoutMs, signal);
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
 * Starts a broker through the launcher, which exits at once, so launchd adopts the broker: Claude Code
 * kills a hook's whole process tree when it stops the hook (F22, plan 7.6). Each runs in a session of
 * its own (setsid), with brokerEnv() as its whole environment; stderr goes to
 * .state/logs/broker.stderr.log.
 */
export function spawnBroker(paths: StatePaths, launch: BrokerLaunch): void {
  ensureStateDir(paths);
  const stderr = openSync(join(paths.logs, "broker.stderr.log"), "a", 0o600);
  const bun = [launch.bun, "--no-env-file", `--config=${launch.bunfig}`];
  try {
    const child = Bun.spawn({
      cmd: [...bun, launch.launcher, ...bun, launch.main],
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
  abort?: AbortSignal,
): Promise<unknown> {
  if (!existsSync(paths.socket) || abort?.aborted) return undefined;
  const init = body === undefined ? {} : { method: "POST", body, headers: JSON_HEADERS };
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = abort === undefined ? timeout : AbortSignal.any([timeout, abort]);
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
  const { paired, pairingUntil, polling } = fields;
  if (
    typeof pid !== "number" ||
    typeof startedAt !== "string" ||
    typeof uptimeSeconds !== "number" ||
    typeof botId !== "number" ||
    typeof tokenFingerprint !== "string" ||
    typeof schema !== "number" ||
    !Array.isArray(envKeys) ||
    !(paired === null || typeof paired === "string") ||
    !(pairingUntil === null || typeof pairingUntil === "string") ||
    typeof polling !== "boolean"
  ) {
    return undefined;
  }
  const keys: readonly unknown[] = envKeys;
  const names = keys.filter((key): key is string => typeof key === "string");
  const presence = parsePresence(fields.presence);
  return {
    pid,
    startedAt,
    uptimeSeconds,
    botId,
    tokenFingerprint,
    schema,
    envKeys: names,
    paired,
    pairingUntil,
    polling,
    ...(presence === undefined ? {} : { presence }),
  };
}

function parsePresence(value: unknown): PresenceHealth | undefined {
  const fields = asFields(value);
  if (fields === undefined) return undefined;
  const { mode, state, because, idleSeconds, locked } = fields;
  if (
    typeof mode !== "string" ||
    typeof state !== "string" ||
    typeof because !== "string" ||
    !(idleSeconds === null || typeof idleSeconds === "number") ||
    !(locked === null || typeof locked === "boolean")
  ) {
    return undefined;
  }
  return { mode, state, because, idleSeconds, locked };
}
