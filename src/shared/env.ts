import { readFileSync, statSync } from "node:fs";
import { ConfigError } from "./errors.ts";
import { Secret } from "./secret.ts";

export const TOKEN_KEY = "TELEGRAM_BOT_TOKEN";

// BotFather's tokens are the bot's number, a colon and 35 characters; the ranges leave some room.
const BOT_NUMBER = /^[0-9]{5,20}$/;
const TOKEN_TAIL = /^[A-Za-z0-9_-]{30,80}$/;
const SHAPE = "the bot's number, a colon, then 35 letters, digits, _ or -";

/**
 * The bot token, read explicitly from `envFile` (<repo>/.env). process.env is never consulted, so a
 * variable inherited from another repo's session can't stand in for it (F13). Errors say what is wrong
 * and how to fix it; none contains the value.
 */
export function loadBotToken(envFile: string): Secret {
  checkEnvFile(envFile);
  const value = parseEnv(readFileSync(envFile, "utf8")).get(TOKEN_KEY);
  if (value === undefined) {
    throw new ConfigError(`.env has no ${TOKEN_KEY} line. Add one: ${TOKEN_KEY}=<token>`);
  }
  if (value === "") {
    throw new ConfigError(`${TOKEN_KEY} in .env is empty. Paste the token after the = sign.`);
  }
  const problem = tokenProblem(value);
  if (problem !== undefined) {
    throw new ConfigError(
      `${TOKEN_KEY} in .env is not a bot token: ${problem}. A token is ${SHAPE}.`,
    );
  }
  return new Secret(value);
}

function checkEnvFile(envFile: string): void {
  const stats = statSync(envFile, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new ConfigError(
      `No .env file at ${envFile}. Create it from .env.example with mode 600, then fill in ${TOKEN_KEY}.`,
    );
  }
  if (!stats.isFile()) throw new ConfigError(`${envFile} is not a regular file.`);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const shown = mode.toString(8).padStart(3, "0");
    throw new ConfigError(`.env can be read by other users (mode ${shown}). Fix: chmod 600 .env`);
  }
}

/** Why `value` is not a bot token, in words that reveal nothing of it; undefined if it is one. */
function tokenProblem(value: string): string | undefined {
  if (/\s/.test(value)) return "it contains spaces";
  if (/["']/.test(value)) return "it contains quote marks";
  const colon = value.indexOf(":");
  if (colon === -1) return "it has no colon";
  if (!BOT_NUMBER.test(value.slice(0, colon))) return "the part before the colon is not a number";
  if (!TOKEN_TAIL.test(value.slice(colon + 1))) {
    return "the part after the colon is not 30 to 80 letters, digits, _ or -";
  }
  return undefined;
}

/**
 * The KEY=value lines of a .env file. Blank lines and # comments are skipped; a value may be quoted and
 * may end with " # comment". Errors name the line, never its text: it may be a pasted token.
 */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    const key = match?.[1];
    if (key === undefined) {
      const hint = `a token goes after ${TOKEN_KEY}= on one line`;
      throw new ConfigError(`.env line ${index + 1} is not KEY=value (${hint}).`);
    }
    if (values.has(key)) {
      throw new ConfigError(`.env sets ${key} twice (again on line ${index + 1}); keep one.`);
    }
    values.set(key, cleanValue(match?.[2] ?? ""));
  }
  return values;
}

function cleanValue(raw: string): string {
  const comment = raw.search(/\s#/);
  const value = (comment === -1 ? raw : raw.slice(0, comment)).trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}
