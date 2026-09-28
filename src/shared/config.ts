import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError } from "./errors.ts";

export type ContentMode = "full" | "ping-only";
const CONTENT_MODES: readonly ContentMode[] = ["full", "ping-only"];

/** config.json with every path made absolute. Paths are matched against CLAUDE_PROJECT_DIR (F15). */
export interface Config {
  /** Sessions that start inside one of these folders are served… */
  readonly serve: readonly string[];
  /** …unless they start inside one of these. */
  readonly skip: readonly string[];
  /** CLAUDE_CODE_ENTRYPOINT values served (F10): claude-vscode is the panel, cli the terminal. */
  readonly entrypoints: readonly string[];
  /** Active under activeSeconds since your last input, away from awaySeconds on (D4, flow 3). */
  readonly presence: { readonly activeSeconds: number; readonly awaySeconds: number };
  /** How much of Claude's text leaves the Mac (O1); pingOnly folders get pings without text. */
  readonly content: { readonly default: ContentMode; readonly pingOnly: readonly string[] };
}

/** Where relative ("sandbox") and "~/" paths in config.json point. */
export interface Places {
  readonly repoRoot: string;
  readonly home: string;
}

/**
 * What applies when config.json or one of its settings is missing; config.example.json spells it out.
 * Only sandbox/ is served until the phase 2 checkpoint, and text stays on the Mac until O1 is decided
 * at step 2.5.
 */
export const DEFAULTS = {
  serve: ["sandbox"],
  skip: [],
  entrypoints: ["claude-vscode", "cli"],
  presence: { activeSeconds: 30, awaySeconds: 180 },
  content: { default: "ping-only", pingOnly: [] },
} as const;

/** Reads config.json; without one, the defaults apply. */
export function loadConfig(file: string, places: Places): Config {
  if (!existsSync(file)) return parseConfig({}, places);
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config.json is not valid JSON: ${reason}`);
  }
  return parseConfig(raw, places);
}

/** Checks every setting and fills in the defaults; a ConfigError names the setting at fault. */
export function parseConfig(raw: unknown, places: Places): Config {
  const top = settings(raw, "", ["serve", "skip", "entrypoints", "presence", "content"]);
  const presence = settings(pick(top, "presence", {}), "presence", [
    "activeSeconds",
    "awaySeconds",
  ]);
  const content = settings(pick(top, "content", {}), "content", ["default", "pingOnly"]);
  const paths = (value: unknown, where: string): string[] =>
    strings(value, where).map((path) => absolutePath(path, where, places));
  const active = pick(presence, "activeSeconds", DEFAULTS.presence.activeSeconds);
  const away = pick(presence, "awaySeconds", DEFAULTS.presence.awaySeconds);
  const config: Config = {
    serve: paths(pick(top, "serve", DEFAULTS.serve), "serve"),
    skip: paths(pick(top, "skip", DEFAULTS.skip), "skip"),
    entrypoints: strings(pick(top, "entrypoints", DEFAULTS.entrypoints), "entrypoints"),
    presence: {
      activeSeconds: seconds(active, "presence.activeSeconds"),
      awaySeconds: seconds(away, "presence.awaySeconds"),
    },
    content: {
      default: contentMode(pick(content, "default", DEFAULTS.content.default)),
      pingOnly: paths(pick(content, "pingOnly", DEFAULTS.content.pingOnly), "content.pingOnly"),
    },
  };
  if (config.presence.activeSeconds >= config.presence.awaySeconds) {
    throw new ConfigError("config.json: presence.activeSeconds must be below awaySeconds");
  }
  return config;
}

/** Relative paths are under the repo and "~/…" under your home folder; the result is absolute. */
export function absolutePath(path: string, where: string, places: Places): string {
  if (path === "~") return places.home;
  if (path.startsWith("~/")) return join(places.home, path.slice(2));
  if (path.startsWith("~")) {
    throw new ConfigError(`config.json: ${where} has "${path}", but only ~/ is understood`);
  }
  return resolve(places.repoRoot, path);
}

type Settings = Readonly<Record<string, unknown>>;

function settings(value: unknown, where: string, known: readonly string[]): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`config.json: ${where || "the file"} must be a JSON object`);
  }
  const unknownKey = Object.keys(value).find((key) => !known.includes(key));
  if (unknownKey !== undefined) {
    const name = where ? `${where}.${unknownKey}` : unknownKey;
    throw new ConfigError(`config.json: unknown setting "${name}"; known: ${known.join(", ")}`);
  }
  return value as Settings;
}

function pick(object: Settings, key: string, fallback: unknown): unknown {
  return Object.hasOwn(object, key) ? object[key] : fallback;
}

function strings(value: unknown, where: string): string[] {
  const problem = `config.json: ${where} must be a list of strings`;
  if (!Array.isArray(value)) throw new ConfigError(problem);
  const items: readonly unknown[] = value;
  if (!items.every((item): item is string => typeof item === "string")) {
    throw new ConfigError(problem);
  }
  const trimmed = items.map((item) => item.trim());
  if (trimmed.includes("")) throw new ConfigError(`config.json: ${where} has an empty entry`);
  return trimmed;
}

function seconds(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`config.json: ${where} must be a whole number of seconds above 0`);
  }
  return value;
}

function contentMode(value: unknown): ContentMode {
  const mode = CONTENT_MODES.find((known) => known === value);
  if (mode === undefined) {
    throw new ConfigError(`config.json: content.default must be "full" or "ping-only"`);
  }
  return mode;
}
