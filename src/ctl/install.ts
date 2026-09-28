import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { asFields } from "../shared/json.ts";

export interface InstallPaths {
  /** ~/.claude/settings.json: its hooks apply to every Claude session on this Mac. */
  readonly settingsFile: string;
  /** <repo>/.state/backups/ */
  readonly backupDir: string;
  /** Bun by absolute path: the VS Code extension's PATH may not include ~/.bun/bin (plan 2.7). */
  readonly bun: string;
  readonly repoRoot: string;
}

type Json = Record<string, unknown>;

/** The command runs through a shell, so every path in it must be safe unquoted. */
const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;

/**
 * Our hook groups, event by event (design §3), as phase 2 needs them: each calls Bun by absolute path
 * with --no-env-file and our bunfig.toml (F13, F14). Stop and the question hook don't wait for a reply
 * yet, so their timeouts stay short; phases 3 and 4 raise them.
 */
export function hookGroups(bun: string, repoRoot: string): Readonly<Record<string, Json[]>> {
  for (const path of [bun, repoRoot]) {
    if (!SAFE_PATH.test(path)) throw new Error(`refusing a path that needs shell quoting: ${path}`);
  }
  const main = `${repoRoot}/src/hooks/main.ts`;
  const group = (event: string, options: Json, matcher?: string): Json[] => [
    {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [
        {
          type: "command",
          command: `${bun} --no-env-file --config=${repoRoot}/bunfig.toml ${main} ${event}`,
          ...options,
        },
      ],
    },
  ];
  return {
    SessionStart: group("SessionStart", { timeout: 5 }),
    UserPromptSubmit: group("UserPromptSubmit", { timeout: 3 }),
    Stop: group("Stop", { timeout: 60, async: true }),
    Notification: group("Notification", { timeout: 10, async: true }, "idle_prompt"),
    PermissionRequest: group("PermissionRequest", { timeout: 10, async: true }),
    StopFailure: group("StopFailure", { timeout: 10, async: true }),
    PreToolUse: group("PreToolUse", { timeout: 10 }, "AskUserQuestion"),
    SessionEnd: group("SessionEnd", { timeout: 5, async: true }),
  };
}

/** Whether a hook runs this repo's hooks/main.ts: that marks it as ours. */
export function isOurs(hook: unknown, repoRoot: string): boolean {
  const command = asFields(hook)?.command;
  return typeof command === "string" && command.includes(`${repoRoot}/src/hooks/main.ts`);
}

/** `settings` without our hooks. Groups and events that held only ours go too; the rest is as it was. */
export function withoutOurs(settings: Json, repoRoot: string): Json {
  const hooks = asFields(settings.hooks);
  if (hooks === undefined) return settings;
  const kept: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const list: readonly unknown[] = groups;
    const rest = list.flatMap((group) => withoutOursIn(group, repoRoot));
    if (rest.length > 0 || list.length === 0) kept[event] = rest;
  }
  return { ...settings, hooks: kept };
}

/** `settings` with our hooks as `groups` has them, after any of ours already there. */
export function withOurs(
  settings: Json,
  groups: Readonly<Record<string, Json[]>>,
  repoRoot: string,
) {
  const base = withoutOurs(settings, repoRoot);
  const hooks: Json = { ...asFields(base.hooks) };
  for (const [event, list] of Object.entries(groups)) {
    const current = hooks[event];
    hooks[event] = [...(Array.isArray(current) ? current : []), ...list];
  }
  return { ...base, hooks };
}

/** How many of our hooks `settings` holds. */
export function countOurs(settings: Json, repoRoot: string): number {
  const hooks = asFields(settings.hooks) ?? {};
  return Object.values(hooks).reduce<number>((total, groups) => {
    const list: readonly unknown[] = Array.isArray(groups) ? groups : [];
    const ours = list.flatMap((group) => {
      const inner = asFields(group)?.hooks;
      return Array.isArray(inner) ? inner.filter((hook) => isOurs(hook, repoRoot)) : [];
    });
    return total + ours.length;
  }, 0);
}

/** The group minus our hooks, as a list: empty when nothing else was in it. */
function withoutOursIn(group: unknown, repoRoot: string): unknown[] {
  const fields = asFields(group);
  const hooks = fields?.hooks;
  if (fields === undefined || !Array.isArray(hooks)) return [group];
  const list: readonly unknown[] = hooks;
  const rest = list.filter((hook) => !isOurs(hook, repoRoot));
  if (rest.length === list.length) return [group];
  return rest.length > 0 ? [{ ...fields, hooks: rest }] : [];
}

export function serialize(settings: Json): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** The file's text and settings; a file that doesn't exist yet reads as {}. A symlink is refused. */
export function readSettings(file: string): { readonly text: string; readonly settings: Json } {
  if (!existsSync(file)) return { text: "", settings: {} };
  if (lstatSync(file).isSymbolicLink())
    throw new Error(`${file} is a symlink; refusing to replace it`);
  const text = readFileSync(file, "utf8");
  const settings = asFields(JSON.parse(text));
  if (settings === undefined) throw new Error(`${file} is not a JSON object`);
  return { text, settings: { ...settings } };
}

/** Copies the settings file to `dir` (0600); the copy's path, or undefined when there is no file. */
export function backup(file: string, dir: string): string | undefined {
  if (!existsSync(file)) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Two backups in one millisecond get a number, so none overwrites another.
  let target = join(dir, `settings.${stamp}.json`);
  for (let n = 2; existsSync(target); n += 1) target = join(dir, `settings.${stamp}-${n}.json`);
  writeFileSync(target, readFileSync(file), { mode: 0o600, flag: "wx" });
  return target;
}

/** Replaces `file` with `text` in one rename, unless it no longer holds `expected`. */
export function writeAtomically(file: string, text: string, expected: string): void {
  const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : 0o644;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode });
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (now !== expected) {
    rmSync(temp);
    throw new Error(`${file} changed while it was being edited; nothing written, run it again`);
  }
  renameSync(temp, file);
}
