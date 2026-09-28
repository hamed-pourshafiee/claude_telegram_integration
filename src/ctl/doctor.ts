import { existsSync } from "node:fs";
import { type Config, loadConfig, type Places } from "../shared/config.ts";
import { loadBotToken, TOKEN_KEY } from "../shared/env.ts";

export interface Check {
  readonly ok: boolean;
  readonly name: string;
  readonly detail: string;
}

export interface DoctorPaths extends Places {
  readonly envFile: string;
  readonly configFile: string;
}

/**
 * Checks the setup and says what to fix. Later steps add their own checks (Telegram, the broker, the
 * hooks; plan 6.1). No check ever prints the token.
 */
export function runDoctor(paths: DoctorPaths): Check[] {
  return [...configChecks(paths), tokenCheck(paths.envFile)];
}

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(0, ...checks.map((check) => check.name.length));
  const line = (check: Check) =>
    `${check.ok ? "✓" : "✗"} ${check.name.padEnd(width)}  ${check.detail}`;
  return checks.map(line).join("\n");
}

function configChecks(paths: DoctorPaths): Check[] {
  const found = existsSync(paths.configFile);
  let config: Config;
  try {
    config = loadConfig(paths.configFile, paths);
  } catch (error) {
    return [{ ok: false, name: "config.json", detail: describe(error) }];
  }
  const show = (folders: readonly string[]) =>
    folders.length === 0 ? "none" : folders.map((path) => tilde(path, paths.home)).join(", ");
  const missing = config.serve.filter((folder) => !existsSync(folder));
  const { activeSeconds, awaySeconds } = config.presence;
  const { default: mode, pingOnly } = config.content;
  return [
    { ok: true, name: "config.json", detail: found ? "read" : "not found, so the defaults apply" },
    missing.length === 0
      ? { ok: true, name: "serve", detail: show(config.serve) }
      : { ok: false, name: "serve", detail: `folder not found: ${show(missing)}` },
    { ok: true, name: "skip", detail: show(config.skip) },
    { ok: true, name: "entrypoints", detail: config.entrypoints.join(", ") || "none" },
    {
      ok: true,
      name: "presence",
      detail: `active under ${activeSeconds} s, away from ${awaySeconds} s`,
    },
    {
      ok: true,
      name: "content",
      detail:
        mode === "ping-only" ? "ping-only everywhere" : `full, but ping-only in: ${show(pingOnly)}`,
    },
  ];
}

function tokenCheck(envFile: string): Check {
  try {
    loadBotToken(envFile);
  } catch (error) {
    return { ok: false, name: ".env", detail: describe(error) };
  }
  return {
    ok: true,
    name: ".env",
    detail: `private to you; ${TOKEN_KEY} is shaped right (not shown)`,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
