import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, parseConfig } from "../../src/shared/config.ts";
import { ConfigError } from "../../src/shared/errors.ts";
import { REPO_ROOT } from "../../src/shared/paths.ts";

const places = { repoRoot: "/work/bridge", home: "/home/me" };

function parseError(raw: unknown): string {
  try {
    parseConfig(raw, places);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("parseConfig did not throw");
}

/** Runs `use` with a config.json holding `text` in a new folder. */
function withConfigFile(text: string, use: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tg-config-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, text);
    use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("defaults", () => {
  test("without config.json only sandbox/ is served, from the panel and the terminal", () => {
    expect(loadConfig("/nonexistent/config.json", places)).toEqual({
      serve: ["/work/bridge/sandbox"],
      skip: [],
      entrypoints: ["claude-vscode", "cli"],
      presence: { activeSeconds: 30, awaySeconds: 180 },
      content: { default: "full", pingOnly: [], maxChars: 3500 },
    });
  });

  test("config.example.json spells out exactly the defaults", () => {
    const example: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "config.example.json"), "utf8"),
    );
    expect(example).toEqual(DEFAULTS);
    expect(parseConfig(example, places)).toEqual(parseConfig({}, places));
  });

  test("a partial config keeps the defaults for the rest, nested ones too", () => {
    const config = parseConfig({ serve: ["~/src"], presence: { awaySeconds: 300 } }, places);
    expect(config.serve).toEqual(["/home/me/src"]);
    expect(config.presence).toEqual({ activeSeconds: 30, awaySeconds: 300 });
    expect(config.entrypoints).toEqual(["claude-vscode", "cli"]);
  });

  test("config.json is read when it exists", () => {
    withConfigFile('{ "skip": ["~/work"] }', (file) => {
      expect(loadConfig(file, places).skip).toEqual(["/home/me/work"]);
    });
  });
});

describe("paths: relative ones are under the repo, ~/ under home", () => {
  test.each([
    ["sandbox", "/work/bridge/sandbox"],
    ["./sandbox/", "/work/bridge/sandbox"],
    ["../other", "/work/other"],
    ["~", "/home/me"],
    ["~/src/app", "/home/me/src/app"],
    ["/opt/code", "/opt/code"],
    [" ~/padded ", "/home/me/padded"],
  ])("%p → %s", (path, expected) => {
    expect(parseConfig({ serve: [path] }, places).serve).toEqual([expected]);
  });

  test("~user/ is refused", () => {
    expect(parseError({ skip: ["~bob/x"] })).toContain("only ~/ is understood");
  });
});

describe("a wrong setting is named in the error", () => {
  test.each<[string, unknown, string]>([
    ["a typo in a setting", { serv: ["x"] }, 'unknown setting "serv"'],
    [
      "a typo inside presence",
      { presence: { awaySecs: 5 } },
      'unknown setting "presence.awaySecs"',
    ],
    ["a list instead of an object", ["sandbox"], "the file must be a JSON object"],
    ["null", null, "the file must be a JSON object"],
    ["presence as a number", { presence: 30 }, "presence must be a JSON object"],
    ["serve as text", { serve: "sandbox" }, "serve must be a list of strings"],
    ["serve as null", { serve: null }, "serve must be a list of strings"],
    ["a number in a list", { skip: [1] }, "skip must be a list of strings"],
    ["an empty entry", { entrypoints: ["cli", " "] }, "entrypoints has an empty entry"],
    ["zero seconds", { presence: { activeSeconds: 0 } }, "activeSeconds must be a whole number"],
    ["a fraction", { presence: { awaySeconds: 1.5 } }, "awaySeconds must be a whole number"],
    ["seconds as text", { presence: { awaySeconds: "180" } }, "awaySeconds must be a whole number"],
    ["active not below away", { presence: { activeSeconds: 180 } }, "must be below awaySeconds"],
    ["an unknown content mode", { content: { default: "summary" } }, "content.default must be"],
    ["a cap too small", { content: { maxChars: 50 } }, "content.maxChars must be a whole number"],
  ])("%s", (_name, raw, expected) => {
    expect(parseError(raw)).toContain(expected);
  });

  test("config.json that is not JSON", () => {
    withConfigFile("{ serve: [sandbox] }", (file) => {
      expect(() => loadConfig(file, places)).toThrow("config.json is not valid JSON");
    });
  });
});
