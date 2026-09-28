// Shared helpers for the phase 1 spikes (implementation-plan 1.2–1.4). Throwaway code.
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Paths come from this file's location, never from the session's cwd (design §3).
export const REPO_ROOT: string = resolve(import.meta.dir, "../..");
export const SANDBOX_DIR: string = join(REPO_ROOT, "sandbox");
export const SPIKE_DIR: string = join(REPO_ROOT, ".state", "spikes");

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/** Whether `child` is `parent` itself or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(canonical(parent), canonical(child));
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/** The hook's JSON input from stdin. */
export async function readHookInput(): Promise<JsonObject> {
  const text = await Bun.stdin.text();
  const input = asObject(JSON.parse(text));
  if (!input) throw new Error(`hook input is not a JSON object (${text.length} bytes)`);
  return input;
}

/** Appends one timestamped JSON line to .state/spikes/<file> (dir 0700, file 0600). */
export function appendLog(file: string, record: JsonObject): void {
  mkdirSync(SPIKE_DIR, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`;
  appendFileSync(join(SPIKE_DIR, file), line, { mode: 0o600 });
}

/** Parent pid and resident memory of `pid`, as the OS reports them now. */
export function processStats(pid: number): { ppid: number | null; rssKB: number | null } {
  const ps = Bun.spawnSync(["/bin/ps", "-o", "ppid=,rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [ppid, rss] = ps.stdout.toString().trim().split(/\s+/).filter(Boolean).map(Number);
  return { ppid: finiteOrNull(ppid), rssKB: finiteOrNull(rss) };
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/** The command name of `pid`, or "" if it is gone. */
export function commandName(pid: number): string {
  const ps = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return ps.stdout.toString().trim();
}
