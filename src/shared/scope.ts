import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Config, ContentMode } from "./config.ts";

/** A session as its hook environment describes it (F10, F15). */
export interface SessionEnv {
  /** CLAUDE_PROJECT_DIR: where the session started. It stays there after a cd (F15). */
  readonly projectDir: string | undefined;
  /** CLAUDE_CODE_ENTRYPOINT: claude-vscode, cli or sdk-cli (F10). */
  readonly entrypoint: string | undefined;
}

export type Scope = { readonly served: true } | { readonly served: false; readonly reason: string };

export function sessionEnv(env: Readonly<Record<string, string | undefined>>): SessionEnv {
  return { projectDir: env.CLAUDE_PROJECT_DIR, entrypoint: env.CLAUDE_CODE_ENTRYPOINT };
}

/**
 * Whether the hooks act for this session. Decided by where the session started, never by the hook
 * input's cwd, which follows a cd (F15).
 */
export function sessionScope(config: Config, session: SessionEnv): Scope {
  const { projectDir, entrypoint } = session;
  if (projectDir === undefined || !isAbsolute(projectDir)) {
    return { served: false, reason: "CLAUDE_PROJECT_DIR is not an absolute path" };
  }
  if (entrypoint === undefined || !config.entrypoints.includes(entrypoint)) {
    return { served: false, reason: `entrypoint ${entrypoint ?? "(unset)"} is not served` };
  }
  // A start folder deleted since can't be resolved, and comparing its path as spelled with resolved
  // folders could slip past the skip list, so such a session is not served.
  if (!existsSync(projectDir)) {
    return { served: false, reason: "the start folder no longer exists" };
  }
  const start = realpathSync(projectDir);
  if (containsAny(config.skip, start)) {
    return { served: false, reason: "started in a skipped folder" };
  }
  if (!containsAny(config.serve, start)) {
    return { served: false, reason: "started outside the served folders" };
  }
  return { served: true };
}

/** O1: whether Claude's text may leave the Mac for a session that started in `projectDir`. */
export function contentModeFor(config: Config, projectDir: string): ContentMode {
  if (config.content.default === "ping-only" || !existsSync(projectDir)) return "ping-only";
  return containsAny(config.content.pingOnly, realpathSync(projectDir)) ? "ping-only" : "full";
}

/** Whether `child` is `parent` itself or inside it. Both must be absolute. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

/**
 * Whether `start` (resolved) is inside one of `folders`, compared with symlinks resolved, so a link
 * into a folder counts as inside it. A folder that doesn't exist can't hold a session, so it is left
 * out rather than compared as spelled.
 */
function containsAny(folders: readonly string[], start: string): boolean {
  return folders.some((folder) => existsSync(folder) && isInside(start, realpathSync(folder)));
}
