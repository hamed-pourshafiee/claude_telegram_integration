import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorPaths, formatChecks, runDoctor } from "../../src/ctl/doctor.ts";
import { TOKEN_KEY } from "../../src/shared/env.ts";
import { apiError, FakeTelegram, ok } from "../helpers/fake-telegram.ts";
import { expectNoLeak, FAKE_SECRET, FAKE_TOKEN } from "../helpers/secrets.ts";

const fake = new FakeTelegram();
const roots: string[] = [];
beforeEach(() => fake.reset());
afterAll(() => {
  fake.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const bot = { id: 7777777777, is_bot: true, first_name: "Bridge", username: "bridge_test_bot" };
const goodEnv = `${TOKEN_KEY}=${FAKE_TOKEN}\n`;

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

/** Runs the doctor against the fake Bot API and checks that its output holds no part of the token. */
async function doctor(paths: DoctorPaths, apiBase = fake.url) {
  const checks = await runDoctor(paths, { apiBase });
  const output = formatChecks(checks);
  expectNoLeak(output);
  return { ok: checks.every((check) => check.ok), output };
}

describe("ctl doctor: .env and Telegram", () => {
  test("a good setup passes, and the output never shows the token", async () => {
    fake.answer("getMe", ok(bot));
    const { ok: passed, output } = await doctor(setup(goodEnv));
    expect(passed).toBe(true);
    expect(output).toContain("✓ .env");
    expect(output).toContain("shaped right (not shown)");
    expect(output).toContain("✓ telegram     the bot @bridge_test_bot answers (getMe)");
    expect(output).toContain("not found, so the defaults apply");
    expect(output).toContain("ping-only everywhere");
    expect(fake.calls("getMe")).toEqual([{ method: "getMe", token: FAKE_TOKEN, body: {} }]);
  });

  test.each<[string, string | undefined, number, string]>([
    ["no .env", undefined, 0o600, "Create it from .env.example"],
    ["the template, not filled in", `${TOKEN_KEY}=\n`, 0o600, "is empty"],
    ["a token readable by others", `${TOKEN_KEY}=${FAKE_TOKEN}`, 0o644, "chmod 600 .env"],
    ["a token with a typo", `${TOKEN_KEY}=${FAKE_TOKEN}!`, 0o600, "after the colon"],
    ["a bare token", `${TOKEN_KEY}=${FAKE_SECRET}`, 0o600, "has no colon"],
  ])(
    "%s fails the .env check, and Telegram is not asked",
    async (_name, envText, mode, expected) => {
      const { ok: passed, output } = await doctor(setup(envText, { mode }));
      expect(passed).toBe(false);
      expect(output).toContain("✗ .env");
      expect(output).toContain(expected);
      expect(output).toContain("✗ telegram     not checked: .env has no usable token");
      expect(fake.calls("getMe")).toEqual([]);
    },
  );

  test("a token Telegram refuses", async () => {
    fake.answer("getMe", apiError(401, "Unauthorized"));
    const { ok: passed, output } = await doctor(setup(goodEnv));
    expect(passed).toBe(false);
    expect(output).toContain("✗ telegram     Telegram refused the token (401 Unauthorized)");
  });

  test("Telegram out of reach, or quoting the URL: still no token", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const apiBase = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    expect((await doctor(setup(goodEnv), apiBase)).output).toContain("getMe: network error");
    fake.answer("getMe", apiError(404, `Not Found: /bot${FAKE_TOKEN}/getMe`));
    expect((await doctor(setup(goodEnv))).output).toContain("/bot7777777777:<token>/getMe");
  });
});

describe("ctl doctor: config.json", () => {
  test("a broken config.json fails, and the token is still checked", async () => {
    fake.answer("getMe", ok(bot));
    const { ok: passed, output } = await doctor(setup(goodEnv, { config: '{ "serv": [] }' }));
    expect(passed).toBe(false);
    expect(output).toContain('unknown setting "serv"');
    expect(output).toContain("✓ .env");
    expect(output).toContain("✓ telegram");
  });

  test("a served folder that doesn't exist fails", async () => {
    fake.answer("getMe", ok(bot));
    const { ok: passed, output } = await doctor(
      setup(goodEnv, { config: '{ "serve": ["~/typo"] }' }),
    );
    expect(passed).toBe(false);
    expect(output).toContain("✗ serve");
    expect(output).toContain("folder not found: ~/typo");
  });
});

test("formatChecks lines up the names", () => {
  const checks = [
    { ok: true, name: "a", detail: "x" },
    { ok: false, name: "long", detail: "y" },
  ];
  expect(formatChecks(checks)).toBe("✓ a     x\n✗ long  y");
});
