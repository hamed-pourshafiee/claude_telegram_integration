import { existsSync } from "node:fs";
import { type Config, loadConfig, type Places } from "../shared/config.ts";
import { loadBotToken, TOKEN_KEY } from "../shared/env.ts";
import type { Secret } from "../shared/secret.ts";
import { TelegramClient } from "../shared/telegram/client.ts";
import { TelegramError } from "../shared/telegram/errors.ts";

export interface Check {
  readonly ok: boolean;
  readonly name: string;
  readonly detail: string;
}

export interface DoctorPaths extends Places {
  readonly envFile: string;
  readonly configFile: string;
}

export interface DoctorOptions {
  /** The Bot API to ask; tests point it at a local fake. */
  readonly apiBase?: string;
}

/**
 * Checks the setup and says what to fix. Later steps add their own checks (the broker, the hooks;
 * plan 6.1). No check ever prints the token.
 */
export async function runDoctor(paths: DoctorPaths, options: DoctorOptions = {}): Promise<Check[]> {
  const token = tokenCheck(paths.envFile);
  return [...configChecks(paths), token.check, await telegramCheck(token.secret, options)];
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

function tokenCheck(envFile: string): { check: Check; secret?: Secret } {
  try {
    const secret = loadBotToken(envFile);
    const detail = `private to you; ${TOKEN_KEY} is shaped right (not shown)`;
    return { check: { ok: true, name: ".env", detail }, secret };
  } catch (error) {
    return { check: { ok: false, name: ".env", detail: describe(error) } };
  }
}

/** Asks Telegram who the bot is (getMe), which proves that the token works. */
async function telegramCheck(secret: Secret | undefined, options: DoctorOptions): Promise<Check> {
  const name = "telegram";
  if (!secret) return { ok: false, name, detail: "not checked: .env has no usable token" };
  try {
    const where = options.apiBase === undefined ? {} : { apiBase: options.apiBase };
    const bot = await new TelegramClient({ token: secret, timeoutMs: 10_000, ...where }).getMe();
    if (!bot.is_bot)
      return { ok: false, name, detail: "the token belongs to an account, not a bot" };
    return { ok: true, name, detail: `the bot @${bot.username ?? bot.first_name} answers (getMe)` };
  } catch (error) {
    if (error instanceof TelegramError && error.code === 401) {
      const fix = "check it in BotFather: /mybots, your bot, API Token";
      return { ok: false, name, detail: `Telegram refused the token (401 Unauthorized); ${fix}` };
    }
    return { ok: false, name, detail: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
