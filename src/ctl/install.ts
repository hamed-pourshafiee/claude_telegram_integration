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

/** A Stop hook waits for a reply up to 12 h, and a question hook for your answers; then SIGTERM (F2). */
const WAIT_SECONDS = 43_200;

/** The spinner while a question hook waits: your answer may come from the chat (flow 3). */
const QUESTION_STATUS = "Sent to Telegram · touch the keyboard or mouse to answer here";
/** Claude's questions (plan 4.1) and its plans waiting for approval (plan 4.2). */
const QUESTION_TOOLS = "AskUserQuestion|ExitPlanMode";

/**
 * Our hook groups, event by event (design §3): each calls Bun by absolute path with --no-env-file and
 * our bunfig.toml (F13, F14). Since phase 3 the Stop hook waits for a reply (--wait) and wakes Claude
 * with it (asyncRewake, F2); since phase 4 the question hook waits for your answers (--wait), with a
 * spinner that says so; since phase 5 the PermissionRequest hook waits for your decision on Bash, Edit
 * and Write (D9) while the dialog is open. The flag and the long timeout go together, so only this
 * install makes a hook wait.
 */
export function hookGroups(bun: string, repoRoot: string): Readonly<Record<string, Json[]>> {
  for (const path of [bun, repoRoot]) {
    if (!SAFE_PATH.test(path)) throw new Error(`refusing a path that needs shell quoting: ${path}`);
  }
  const main = `${repoRoot}/src/hooks/main.ts`;
  const group = (event: string, options: Json, matcher?: string, flag = ""): Json[] => [
    {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [
        {
          type: "command",
          command: `${bun} --no-env-file --config=${repoRoot}/bunfig.toml ${main} ${event}${flag}`,
          ...options,
        },
      ],
    },
  ];
  return {
    SessionStart: group("SessionStart", { timeout: 5 }),
    UserPromptSubmit: group("UserPromptSubmit", { timeout: 3 }),
    Stop: group("Stop", { timeout: WAIT_SECONDS, asyncRewake: true }, undefined, " --wait"),
    Notification: group("Notification", { timeout: 10, async: true }, "idle_prompt"),
    PermissionRequest: group("PermissionRequest", { timeout: WAIT_SECONDS }, undefined, " --wait"),
    StopFailure: group("StopFailure", { timeout: 10, async: true }),
    PreToolUse: group(
      "PreToolUse",
      { timeout: WAIT_SECONDS, statusMessage: QUESTION_STATUS },
      QUESTION_TOOLS,
      " --wait",
    ),
    PostToolUse: group("PostToolUse", { timeout: 10, async: true }, QUESTION_TOOLS),
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
