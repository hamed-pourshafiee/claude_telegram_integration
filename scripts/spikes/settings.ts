// Adds or removes the phase 1 spike hooks in ~/.claude/settings.json (implementation-plan 1.2–1.5).
// Throwaway. `show` prints what `add` would append; `backup` copies the file to .state/backups/;
// `add` backs up, then writes atomically; `remove` drops only groups whose command runs a script in
// scripts/spikes/ and says which backup, if any, the result is byte-identical to.
// Usage: bun scripts/spikes/settings.ts show <spike> | backup | add <spike> | remove
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asObject, type JsonObject, REPO_ROOT } from "./lib.ts";

const SETTINGS_FILE = join(homedir(), ".claude", "settings.json");
const SPIKES_DIR = join(REPO_ROOT, "scripts", "spikes");
const BACKUP_DIR = join(REPO_ROOT, ".state", "backups");
const SAFE_PATH = /^[A-Za-z0-9/._-]+$/;

export interface SpikeEntry {
  event: string;
  group: JsonObject;
}

/** The settings group each spike adds. Paths must be shell-safe: the command runs through a shell. */
export function spikeEntries(bun: string, repoRoot: string): Record<string, SpikeEntry> {
  for (const path of [bun, repoRoot]) {
    if (!SAFE_PATH.test(path)) throw new Error(`path needs shell quoting, refusing: ${path}`);
  }
  const run = (script: string): string =>
    `${bun} --no-env-file --config=${repoRoot}/bunfig.toml ${repoRoot}/scripts/spikes/${script}`;
  const command = (script: string, extra: JsonObject): JsonObject => ({
    hooks: [{ type: "command", command: run(script), ...extra }],
  });
  return {
    s1: { event: "Stop", group: command("s1-stop-rewake.ts", { timeout: 900, asyncRewake: true }) },
  };
}

/** `settings` with `group` appended to hooks[event], unless an identical group is already there. */
export function withGroup(settings: JsonObject, event: string, group: JsonObject): JsonObject {
  const hooks = asObject(settings.hooks) ?? {};
  const current = hooks[event];
  const groups: unknown[] = Array.isArray(current) ? current : [];
  if (groups.some((g) => JSON.stringify(g) === JSON.stringify(group))) return settings;
  return { ...settings, hooks: { ...hooks, [event]: [...groups, group] } };
}

/** `settings` without hooks that run a script in `spikesDir`; groups and events left empty go too. */
export function withoutSpikes(settings: JsonObject, spikesDir: string): JsonObject {
  const hooks = asObject(settings.hooks);
  if (!hooks) return settings;
  const kept: JsonObject = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const rest = groups.flatMap((group) => withoutSpikeHooks(group, spikesDir));
    if (rest.length > 0 || groups.length === 0) kept[event] = rest;
  }
  return { ...settings, hooks: kept };
}

/** The group minus its spike hooks, as a list: empty when nothing else was in it. */
function withoutSpikeHooks(group: unknown, spikesDir: string): unknown[] {
  const object = asObject(group);
  const hooks = object?.hooks;
  if (!object || !Array.isArray(hooks)) return [group];
  const rest = hooks.filter((hook) => !runsSpike(hook, spikesDir));
  if (rest.length === hooks.length) return [group];
  return rest.length > 0 ? [{ ...object, hooks: rest }] : [];
}

function runsSpike(hook: unknown, spikesDir: string): boolean {
  const command = asObject(hook)?.command;
  return typeof command === "string" && command.includes(`${spikesDir}/`);
}

function serialize(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function readSettings(): { text: string; settings: JsonObject } {
  if (lstatSync(SETTINGS_FILE).isSymbolicLink()) {
    throw new Error(`${SETTINGS_FILE} is a symlink; refusing to replace it`);
  }
  const text = readFileSync(SETTINGS_FILE, "utf8");
  const settings = asObject(JSON.parse(text));
  if (!settings) throw new Error(`${SETTINGS_FILE} is not a JSON object`);
  return { text, settings };
}

function backup(): string {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const target = join(
    BACKUP_DIR,
    `settings.${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(target, readFileSync(SETTINGS_FILE), { mode: 0o600, flag: "wx" });
  return target;
}

/** Replaces the file with `text`, unless it no longer holds `expected` (someone else wrote it). */
function writeAtomically(text: string, expected: string): void {
  const mode = lstatSync(SETTINGS_FILE).mode & 0o777;
  const temp = `${SETTINGS_FILE}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode });
  if (readFileSync(SETTINGS_FILE, "utf8") !== expected) {
    rmSync(temp);
    throw new Error(`${SETTINGS_FILE} changed while editing; nothing written, run again`);
  }
  renameSync(temp, SETTINGS_FILE);
  readSettings(); // still parses
}

function identicalBackup(text: string): string | undefined {
  const names = readdirSync(BACKUP_DIR).filter((name) => name.startsWith("settings."));
  return names.sort().find((name) => readFileSync(join(BACKUP_DIR, name), "utf8") === text);
}

function run(argv: string[]): void {
  const [action, spike = ""] = argv;
  if (action === "backup") {
    console.log(`backup: ${backup()}`);
  } else if (action === "remove") {
    remove();
  } else if (action === "show" || action === "add") {
    const entry = spikeEntries(process.execPath, REPO_ROOT)[spike];
    if (!entry) throw new Error(`unknown spike "${spike}"`);
    if (action === "show") {
      console.log(`${SETTINGS_FILE}, append to hooks.${entry.event}:\n${serialize(entry.group)}`);
    } else {
      add(spike, entry);
    }
  } else {
    throw new Error("usage: settings.ts show <spike> | backup | add <spike> | remove");
  }
}

function add(spike: string, entry: SpikeEntry): void {
  const { text, settings } = readSettings();
  const next = serialize(withGroup(settings, entry.event, entry.group));
  if (next === text) {
    console.log(`${spike} is already installed; nothing changed`);
    return;
  }
  const saved = backup();
  writeAtomically(next, text);
  console.log(`added ${spike} to hooks.${entry.event}; previous file: ${saved}`);
}

function remove(): void {
  const { text, settings } = readSettings();
  const next = serialize(withoutSpikes(settings, SPIKES_DIR));
  if (next === text) {
    console.log("no spike entries found; nothing changed");
    return;
  }
  const saved = backup();
  writeAtomically(next, text);
  const same = identicalBackup(next);
  console.log(`removed spike entries; previous file: ${saved}`);
  console.log(
    same ? `now byte-identical to backup ${same}` : "differs from every backup (edited since)",
  );
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    console.error("settings.ts: unhandled rejection:", reason);
    process.exit(1);
  });
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`settings.ts failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
