import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SCHEMA_VERSION } from "../broker/db.ts";
import { type BrokerHealth, brokerEnv, brokerHealth } from "../shared/broker-client.ts";
import { loadBotToken } from "../shared/env.ts";
import { errorCode, messageOf } from "../shared/errors.ts";
import { asFields, type Fields } from "../shared/json.ts";
import { noLog } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { isDisabled } from "../shared/state.ts";
import type { Check } from "./doctor.ts";
import { hookGroups, ourEntries, readSettings } from "./install.ts";

/** The Claude Code versions the bridge was tested with; the README lists the same. */
export const TESTED_CLAUDE_CODE: readonly string[] = ["2.1.274", "2.1.283", "2.1.284"];
/** How many of the latest stops the F16 check reads. */
export const RECENT_STOPS = 10;

export interface LocalPaths {
  readonly state: StatePaths;
  readonly envFile: string;
  /** ~/.claude/settings.json */
  readonly settingsFile: string;
  /** The Bun that runs ctl, which install writes into the hooks. */
  readonly bun: string;
  readonly repoRoot: string;
}

/**
 * The checks of this Mac's side (plan 6.1): the broker, the privacy of .state/ (design §5), our hooks
 * and the Bun they run, and whether the latest stops were read (F16). They only look: nothing is
 * started, created or changed.
 */
export async function localChecks(paths: LocalPaths): Promise<Check[]> {
  const hooks = hooksCheck(paths);
  return [
    await brokerCheck(paths),
    stateCheck(paths.state),
    hooks.check,
    bunCheck(hooks.bun ?? paths.bun, hooks.bun !== undefined, paths.bun),
    stopsCheck(paths.state.logs),
  ];
}

async function brokerCheck({ state, envFile }: LocalPaths): Promise<Check> {
  const name = "broker";
  if (isDisabled(state)) {
    return { ok: false, name, detail: "disabled: hooks do nothing ('bun run ctl enable')" };
  }
  const health = await brokerHealth(state, noLog);
  if (health === undefined)
    return { ok: true, name, detail: "not running; the next hook starts it" };
  const about = `pid ${health.pid}, up ${duration(health.uptimeSeconds)}, schema ${health.schema}`;
  const wrong = brokerProblems(health, envFile);
  if (wrong.length > 0) return { ok: false, name, detail: `${about}; ${wrong.join("; ")}` };
  return { ok: true, name, detail: `${about}, with this repo's token and a clean environment` };
}

/** What is wrong with a running broker: an old schema, another token, a stray variable (D3). */
function brokerProblems(health: BrokerHealth, envFile: string): string[] {
  const wrong: string[] = [];
  const restart = "restart it ('bun run ctl stop', then 'start')";
  if (health.schema !== SCHEMA_VERSION)
    wrong.push(`this code needs schema ${SCHEMA_VERSION}: ${restart}`);
  const token = sameToken(health, envFile);
  if (token === false) wrong.push(`it uses ANOTHER token than .env's: ${restart}`);
  if (typeof token === "string") wrong.push(token);
  const expected = Object.keys(brokerEnv());
  const extra = health.envKeys.filter((key) => !expected.includes(key));
  if (extra.length > 0) wrong.push(`variables it should not have: ${extra.join(", ")}`);
  return wrong;
}

/** Whether the broker uses .env's token, by fingerprint; why they can't be compared, if not. */
function sameToken(health: BrokerHealth, envFile: string): boolean | string {
  try {
    return loadBotToken(envFile).fingerprint() === health.tokenFingerprint;
  } catch (error) {
    return `its token can't be compared with .env's: ${messageOf(error)}`;
  }
}

/** Design §5: .state/ and its folders 0700, and what lies in them 0600, the socket included. */
function stateCheck(state: StatePaths): Check {
  const name = "state";
  if (!existsSync(state.dir))
    return { ok: true, name, detail: "no .state/ yet: the broker makes it" };
  const folders = [state.dir, state.logs, join(state.dir, "backups")].filter((dir) =>
    existsSync(dir),
  );
  const entries = folders.flatMap((dir) => readdirSync(dir).map((entry) => join(dir, entry)));
  const loose = [...folders, ...entries].flatMap((path) => {
    const stat = statOf(path);
    // Folders other than ours (spikes/) are private through .state/ itself.
    if (stat === undefined || (stat.isDirectory() && !folders.includes(path))) return [];
    const mode = stat.mode & 0o777;
    return (mode & 0o077) === 0
      ? []
      : [`${relative(dirname(state.dir), path)} ${mode.toString(8)}`];
  });
  if (loose.length === 0) {
    return {
      ok: true,
      name,
      detail: "private: .state/ and its folders 0700, what is in them 0600",
    };
  }
  return { ok: false, name, detail: `open to others: ${loose.join(", ")}; 'chmod go-rwx' them` };
}

/** A path's lstat, or undefined if it went since the folder was read (the database's -shm, say). */
function statOf(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Are our hooks in settings.json as this version installs them? And which Bun do they run? */
function hooksCheck({ settingsFile, repoRoot }: LocalPaths): { check: Check; bun?: string } {
  const name = "hooks";
  try {
    const { settings } = readSettings(settingsFile);
    const installed = ourEntries(settings, repoRoot).sort();
    if (installed.length === 0) {
      return { check: { ok: false, name, detail: "not installed: 'bun run ctl install'" } };
    }
    // An entry is "event, tab, matcher, tab, the hook as JSON"; its command starts with the Bun.
    const hook = asFields(JSON.parse(installed[0]?.split("\t")[2] ?? "{}"));
    const bun = typeof hook?.command === "string" ? hook.command.split(" ")[0] : undefined;
    if (bun === undefined) throw new Error("our hooks name no Bun");
    const expected = ourEntries({ hooks: hookGroups(bun, repoRoot) }, repoRoot).sort();
    const same = JSON.stringify(installed) === JSON.stringify(expected);
    const detail = same
      ? `${installed.length} installed, as this version installs them`
      : `${installed.length} of ours, not as this version installs them: see 'bun run ctl install --dry-run'`;
    return { check: { ok: same, name, detail }, bun };
  } catch (error) {
    return { check: { ok: false, name, detail: `${settingsFile}: ${messageOf(error)}` } };
  }
}

/** The Bun the hooks run (ctl's, before install): is it there, and which version? */
function bunCheck(bun: string, fromHooks: boolean, ctlBun: string): Check {
  const name = "bun";
  const who = fromHooks ? "the hooks run" : "ctl runs";
  if (!executable(bun)) {
    const fix = "reinstall Bun, or run 'bun run ctl install' with the Bun you have";
    return { ok: false, name, detail: `${who} ${bun}, which is not there: ${fix}` };
  }
  const version = Bun.spawnSync([bun, "--version"], { stderr: "ignore" }).stdout.toString().trim();
  const other = fromHooks && bun !== ctlBun ? `; ctl runs ${ctlBun}` : "";
  return { ok: true, name, detail: `${who} ${bun} ${version || "(no version)"}${other}` };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    // Missing or not executable: bunCheck says so. Anything else is not a check's answer.
    if (["ENOENT", "EACCES", "ENOTDIR"].includes(errorCode(error))) return false;
    throw error;
  }
}

/**
 * F16 is undocumented: each stop's summary in its transcript. The Stop hook logs how it read every
 * stop; a summary that didn't come in time, among the latest stops, means Claude Code may have changed
 * its transcripts. The versions the stops name are listed, with any not tested.
 */
function stopsCheck(logs: string): Check {
  const name = "stops";
  const stops = recentStops(logs, RECENT_STOPS);
  if (stops.length === 0) return { ok: true, name, detail: "none logged yet" };
  const count = (outcome: string) => stops.filter((stop) => stop.outcome === outcome).length;
  const missed = stops.filter((stop) => stop.reason === "no summary in time").length;
  const seen = versionsSeen(stops);
  if (missed > 0) {
    const why = "Claude Code may have changed its transcripts (F16)";
    return {
      ok: false,
      name,
      detail: `${missed} of the last ${stops.length} had no summary in time: ${why}${seen}`,
    };
  }
  const unknown = count("unknown") > 0 ? `, ${count("unknown")} unknown` : "";
  const read = `${count("finish")} finished, ${count("continuing")} continuing${unknown}`;
  return { ok: true, name, detail: `the last ${stops.length} read: ${read}${seen}` };
}

function versionsSeen(stops: readonly Fields[]): string {
  const named = stops.flatMap((stop) => (typeof stop.version === "string" ? [stop.version] : []));
  const versions = [...new Set(named)];
  if (versions.length === 0) return "";
  const untested = versions.filter((version) => !TESTED_CLAUDE_CODE.includes(version));
  const note = untested.length > 0 ? ` (not tested: ${untested.join(", ")})` : "";
  return `; Claude Code ${versions.join(", ")}${note}`;
}

/** The latest `count` stops in hooks.log, and in its rotated copy when that one holds too few. */
function recentStops(logs: string, count: number): Fields[] {
  const stops: Fields[] = [];
  for (const file of ["hooks.log", "hooks.log.1"]) {
    const path = join(logs, file);
    if (stops.length >= count || !existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    stops.unshift(...lines.flatMap((line) => stopOf(line)));
  }
  return stops.slice(-count);
}

function stopOf(line: string): Fields[] {
  if (!line.includes('"hook.stop"')) return [];
  try {
    const entry = asFields(JSON.parse(line));
    return entry?.event === "hook.stop" ? [entry] : [];
  } catch {
    return []; // a line cut short by a crash: it names no stop
  }
}

function duration(seconds: number): string {
  if (seconds < 120) return `${Math.floor(seconds)} s`;
  if (seconds < 7200) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}
