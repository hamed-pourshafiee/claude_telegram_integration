import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorPaths, formatChecks, runDoctor } from "../../src/ctl/doctor.ts";
import { TOKEN_KEY } from "../../src/shared/env.ts";
import { expectNoLeak, FAKE_SECRET, FAKE_TOKEN } from "../helpers/secrets.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repo folder with sandbox/, a .env holding `envText` (none if undefined) and maybe config.json. */
function setup(envText: string | undefined, options: { mode?: number; config?: string } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "tg-doctor-"));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, "sandbox"));
  const paths: DoctorPaths = {
    envFile: join(repoRoot, ".env"),
    configFile: join(repoRoot, "config.json"),
    repoRoot,
    home: "/home/nobody",
  };
  if (envText !== undefined) {
    writeFileSync(paths.envFile, envText);
    chmodSync(paths.envFile, options.mode ?? 0o600);
  }
  if (options.config !== undefined) writeFileSync(paths.configFile, options.config);
  return paths;
}

/** Runs the doctor and checks that its output holds no part of the token. */
function doctor(paths: DoctorPaths): { ok: boolean; output: string } {
  const checks = runDoctor(paths);
  const output = formatChecks(checks);
  expectNoLeak(output);
  return { ok: checks.every((check) => check.ok), output };
}

describe("ctl doctor", () => {
  test("a good setup passes, and the output never shows the token", () => {
    const { ok, output } = doctor(setup(`${TOKEN_KEY}=${FAKE_TOKEN}\n`));
    expect(ok).toBe(true);
    expect(output).toContain("✓ .env");
    expect(output).toContain("shaped right (not shown)");
    expect(output).toContain("not found, so the defaults apply");
    expect(output).toContain("ping-only everywhere");
  });

  test.each<[string, string | undefined, number, string]>([
    ["no .env", undefined, 0o600, "Create it from .env.example"],
    ["the template, not filled in", `${TOKEN_KEY}=\n`, 0o600, "is empty"],
    ["a token readable by others", `${TOKEN_KEY}=${FAKE_TOKEN}`, 0o644, "chmod 600 .env"],
    ["a token with a typo", `${TOKEN_KEY}=${FAKE_TOKEN}!`, 0o600, "after the colon"],
    ["a bare token", `${TOKEN_KEY}=${FAKE_SECRET}`, 0o600, "has no colon"],
  ])("%s fails the .env check, without showing the token", (_name, envText, mode, expected) => {
    const { ok, output } = doctor(setup(envText, { mode }));
    expect(ok).toBe(false);
    expect(output).toContain(`✗ .env`);
    expect(output).toContain(expected);
  });

  test("a broken config.json fails, and .env is still checked", () => {
    const paths = setup(`${TOKEN_KEY}=${FAKE_TOKEN}`, { config: '{ "serv": [] }' });
    const { ok, output } = doctor(paths);
    expect(ok).toBe(false);
    expect(output).toContain('unknown setting "serv"');
    expect(output).toContain("✓ .env");
  });

  test("a served folder that doesn't exist fails", () => {
    const paths = setup(`${TOKEN_KEY}=${FAKE_TOKEN}`, { config: '{ "serve": ["~/typo"] }' });
    const { ok, output } = doctor(paths);
    expect(ok).toBe(false);
    expect(output).toContain("✗ serve");
    expect(output).toContain("folder not found: ~/typo");
  });

  test("formatChecks lines up the names", () => {
    const checks = [
      { ok: true, name: "a", detail: "x" },
      { ok: false, name: "long", detail: "y" },
    ];
    expect(formatChecks(checks)).toBe("✓ a     x\n✗ long  y");
  });
});
