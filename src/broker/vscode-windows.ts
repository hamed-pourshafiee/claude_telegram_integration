import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, messageOf } from "../shared/errors.ts";
import { asFields, type Fields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import { HOME_DIR } from "../shared/paths.ts";

/** A VS Code window, as /new offers it (D11, plan 7.7). */
export interface VsWindow {
  /** What VS Code calls it: its folder's name, or its workspace's. */
  readonly name: string;
  /** Where a session in it runs: its folder, or its workspace's first folder. */
  readonly folder: string;
  /** A workspace's other folders, which its sessions may use too (`--add-dir`). */
  readonly addDirs: readonly string[];
}

/** Where VS Code keeps its windows' state (F28). */
export const VS_CODE_STATE = join(
  HOME_DIR,
  "Library/Application Support/Code/User/globalStorage/storage.json",
);
/** VS Code's main process, not its helpers, which live under Frameworks/. */
const VS_CODE_MAIN = /\/Visual Studio Code\.app\/Contents\/MacOS\/[^/]+$/;

/** Whether VS Code runs: its window state outlives it, to restore the windows. */
export function vsCodeRuns(): boolean {
  const ps = Bun.spawnSync(["/bin/ps", "-axo", "comm="], { stderr: "ignore" });
  return ps.stdout
    .toString()
    .split("\n")
    .some((line) => VS_CODE_MAIN.test(line.trim()));
}

/**
 * The windows VS Code has open, in its order (F28): each a folder, or a workspace whose sessions run in
 * its first folder. None while VS Code isn't running, or when its state can't be read (logged).
 */
export function openWindows(log: Log, state = VS_CODE_STATE, runs = vsCodeRuns): VsWindow[] {
  if (!runs()) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(state, "utf8"));
  } catch (error) {
    log("vscode.unreadable", { error: errorCode(error) ?? messageOf(error) });
    return [];
  }
  const windows = asFields(asFields(data)?.windowsState);
  const opened = Array.isArray(windows?.openedWindows) ? windows.openedWindows : [];
  const entries = [...opened, windows?.lastActiveWindow].flatMap((entry) => {
    const fields = asFields(entry);
    return fields === undefined ? [] : [fields];
  });
  const found = new Map<string, VsWindow>();
  for (const entry of entries) {
    const window = windowOf(entry, log);
    if (window !== undefined && !found.has(window.folder)) found.set(window.folder, window);
  }
  return [...found.values()];
}

function windowOf(entry: Fields, log: Log): VsWindow | undefined {
  if (typeof entry.folder === "string") {
    const folder = localPath(entry.folder, log);
    return folder !== undefined && isFolder(folder)
      ? { name: basename(folder), folder, addDirs: [] }
      : undefined;
  }
  const config = asFields(entry.workspaceIdentifier)?.configURIPath;
  const file = typeof config === "string" ? localPath(config, log) : undefined;
  if (file === undefined) return undefined;
  const [first, ...rest] = workspaceFolders(file, log);
  if (first === undefined) return undefined;
  return { name: basename(file, ".code-workspace"), folder: first, addDirs: rest };
}

/** A workspace's folders that exist, resolved from the file's own folder. */
function workspaceFolders(file: string, log: Log): string[] {
  let workspace: unknown;
  try {
    workspace = parseJsonc(readFileSync(file, "utf8"));
  } catch (error) {
    log("vscode.workspace-unreadable", { error: errorCode(error) ?? messageOf(error) });
    return [];
  }
  const folders = asFields(workspace)?.folders;
  return (Array.isArray(folders) ? folders : [])
    .flatMap((folder) => {
      const path = asFields(folder)?.path;
      return typeof path === "string" ? [resolve(dirname(file), path)] : [];
    })
    .filter(isFolder);
}

/** A file: URI's path; a remote window (another machine, a container) has none here. */
function localPath(uri: string, log: Log): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch (error) {
    log("vscode.bad-uri", { error: messageOf(error) });
    return undefined;
  }
}

function isFolder(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * JSON with comments and trailing commas, as VS Code writes .code-workspace files. What's inside
 * strings is kept as it is, `//` in a URL included.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(withoutTrailingCommas(withoutComments(text)));
}

function withoutComments(text: string): string {
  let out = "";
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const next = text[at + 1] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        at += 1;
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (at + 1 < text.length && text[at + 1] !== "\n") at += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", at + 2);
      at = end === -1 ? text.length : end + 1;
    } else out += char;
  }
  return out;
}

function withoutTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[at + 1] ?? "";
        at += 1;
      } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char !== "," || !/^\s*[}\]]/.test(text.slice(at + 1))) {
      // A comma before a closing bracket is a trailing one: dropped.
      out += char;
    }
  }
  return out;
}
