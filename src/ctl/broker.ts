import { existsSync, readFileSync } from "node:fs";
import { type BrokerLaunch, brokerHealth, ensureBroker } from "../shared/broker-client.ts";
import { loadBotToken } from "../shared/env.ts";
import { messageOf } from "../shared/errors.ts";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { isDisabled, setDisabled } from "../shared/state.ts";

/** What a ctl command reports, and whether it succeeded. */
export interface Outcome {
  readonly ok: boolean;
  readonly text: string;
}

export async function startBroker(
  paths: StatePaths,
  launch: BrokerLaunch,
  log: Log,
): Promise<Outcome> {
  const state = await ensureBroker(paths, launch, log);
  if (state === "disabled") return { ok: false, text: "disabled: run 'bun run ctl enable' first" };
  if (state === "failed") {
    return { ok: false, text: "didn't start within 3 s; see .state/logs/broker.log" };
  }
  const pid = (await brokerHealth(paths, log))?.pid ?? "?";
  return { ok: true, text: `${state === "started" ? "started" : "already running"} (pid ${pid})` };
}

/** Stops the broker with SIGTERM, or SIGKILL if it hasn't gone after 5 s. */
export async function stopBroker(
  paths: StatePaths,
  launch: BrokerLaunch,
  log: Log,
): Promise<Outcome> {
  const pid = (await brokerHealth(paths, log))?.pid ?? pidFromFile(paths, launch);
  if (pid === undefined) return { ok: true, text: "not running" };
  process.kill(pid, "SIGTERM");
  if (await gone(pid, 5000)) return { ok: true, text: `stopped (pid ${pid})` };
  process.kill(pid, "SIGKILL");
  if (await gone(pid, 1000)) return { ok: true, text: `killed after 5 s (pid ${pid})` };
  return { ok: false, text: `pid ${pid} would not stop` };
}

export async function brokerStatus(paths: StatePaths, envFile: string, log: Log): Promise<Outcome> {
  const disabled = isDisabled(paths);
  const health = await brokerHealth(paths, log);
  const lines: string[] = [];
  if (disabled) {
    lines.push("disabled: hooks do nothing and nothing starts the broker ('bun run ctl enable')");
  }
  if (health) {
    const { pid, uptimeSeconds, tokenFingerprint, paired, pairingUntil } = health;
    lines.push(
      `running: pid ${pid}, up ${uptimeSeconds} s, ${whichToken(tokenFingerprint, envFile)}`,
    );
    lines.push(paired === null ? "not paired: run 'bun run ctl pair'" : `paired with ${paired}`);
    if (pairingUntil !== null)
      lines.push(`a pairing code is waiting, until ${clock(pairingUntil)}`);
  } else {
    lines.push(
      disabled ? "not running" : "not running; the next hook or 'bun run ctl start' starts it",
    );
  }
  return { ok: disabled || health !== undefined, text: lines.join("\n") };
}

/** Sets the disabled flag first, so nothing restarts the broker, then stops it (design §6). */
export async function disableBridge(
  paths: StatePaths,
  launch: BrokerLaunch,
  log: Log,
): Promise<Outcome> {
  setDisabled(paths, true);
  const stopped = await stopBroker(paths, launch, log);
  return { ok: stopped.ok, text: `disabled; the broker: ${stopped.text}` };
}

export function enableBridge(paths: StatePaths): Outcome {
  setDisabled(paths, false);
  return { ok: true, text: "enabled; the next hook or 'bun run ctl start' starts the broker" };
}

/**
 * Whether the broker uses the token now in .env, compared by fingerprint: a token replaced in BotFather
 * keeps its bot id, so the id alone can't tell.
 */
function whichToken(fingerprint: string, envFile: string): string {
  try {
    const same = loadBotToken(envFile).fingerprint() === fingerprint;
    return same ? "with this repo's token" : "with ANOTHER token than .env's: restart it";
  } catch (error) {
    return `and .env can't be checked: ${messageOf(error)}`;
  }
}

/** An ISO time as the local hour and minute, such as 14:05. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The pid in .state/broker.pid, if that process is this repo's broker (pids get reused). */
function pidFromFile(paths: StatePaths, launch: BrokerLaunch): number | undefined {
  if (!existsSync(paths.pid)) return undefined;
  const pid = Number.parseInt(readFileSync(paths.pid, "utf8"), 10);
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  const ps = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)], { stderr: "ignore" });
  return ps.stdout.toString().includes(launch.main) ? pid : undefined;
}

async function gone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return !alive(pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return asFields(error)?.code === "EPERM"; // exists, but isn't ours; ESRCH means it is gone
  }
}
