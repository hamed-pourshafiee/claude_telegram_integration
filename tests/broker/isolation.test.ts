import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ENV, RepoCopy } from "../helpers/repo-copy.ts";

// Plan 2.3: sessions in two unrelated repos, one with a .env that sets TELEGRAM_BOT_TOKEN and a
// bunfig.toml with a preload, reach the same broker; it uses this repo's token, and none of that
// repo's code runs (F13, F14).
const copy = new RepoCopy();
afterAll(() => copy.remove());

const plain = join(copy.sandbox, "plain-repo");
const hostile = join(copy.sandbox, "hostile-repo");
const ran = join(copy.root, "hostile-code-ran");
const OTHER_TOKEN = `1234567:${"Z".repeat(35)}`;
mkdirSync(plain);
mkdirSync(hostile);
writeFileSync(join(hostile, ".env"), `TELEGRAM_BOT_TOKEN=${OTHER_TOKEN}\n`);
writeFileSync(join(hostile, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
writeFileSync(
  join(hostile, "evil.ts"),
  `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "x");\n`,
);

test("control: without our flags, Bun in the hostile repo loads its .env and runs its preload", () => {
  const probe = "console.log(process.env.TELEGRAM_BOT_TOKEN === undefined ? 'unset' : 'set')";
  const run = Bun.spawnSync([process.execPath, "-e", probe], {
    cwd: hostile,
    env: { ...BASE_ENV },
  });
  expect(run.stdout.toString().trim()).toBe("set");
  expect(existsSync(ran)).toBe(true);
  rmSync(ran);
});

describe("hooks from two unrelated repos", () => {
  test("reach the same broker, which uses this repo's token and a minimal environment", async () => {
    const leaked = { TELEGRAM_BOT_TOKEN: OTHER_TOKEN, SOME_SESSION_VARIABLE: "1" };
    const fromHostile = copy.hook("SessionStart", hostile, leaked);
    const fromPlain = copy.hook("SessionStart", plain);
    // Our SessionStart hook ran in both: its output is the note of design §3.
    const note = expect.stringContaining('"hookEventName":"SessionStart"');
    expect(fromHostile).toMatchObject({ exitCode: 0, stdout: note });
    expect(fromPlain).toMatchObject({ exitCode: 0, stdout: note });
    const events = copy.logged("broker").filter((entry) => entry.event === "hook.event");
    expect(events.map((entry) => entry.session)).toEqual([fromHostile.session, fromPlain.session]);
    expect(new Set(events.map((entry) => entry.pid)).size).toBe(1);
    const health = await copy.health();
    expect(health?.botId).toBe(7777777777);
    expect(health?.envKeys).toEqual(["HOME", "LOGNAME", "PATH", "USER"]);
  }, 20_000);

  test("and none of the hostile repo's code ran, in the hook or the broker", () => {
    expect(existsSync(ran)).toBe(false);
  });
});

describe("a hook that isn't for us does nothing, and says nothing", () => {
  const brokerEvents = () => copy.logged("broker").filter((entry) => entry.event === "hook.event");

  test("a session started outside the served folders", () => {
    const before = brokerEvents().length;
    expect(copy.hook("SessionStart", copy.root)).toMatchObject({ exitCode: 0, stdout: "" });
    expect(brokerEvents()).toHaveLength(before);
  }, 20_000);

  test("BUN_CONFIG_VERBOSE_FETCH set: logged, and the broker is not called", () => {
    const before = brokerEvents().length;
    const run = copy.hook("Stop", plain, { BUN_CONFIG_VERBOSE_FETCH: "curl" });
    expect(run).toMatchObject({ exitCode: 0, stdout: "" });
    expect(brokerEvents()).toHaveLength(before);
    const failed = copy.logged("hooks").filter((entry) => entry.event === "hook.failed");
    expect(String(failed.at(-1)?.error)).toContain("BUN_CONFIG_VERBOSE_FETCH");
  }, 20_000);

  test("input that isn't JSON: only its size is logged", () => {
    const secretText = "Claude's private reply text";
    const env = { CLAUDE_PROJECT_DIR: plain, CLAUDE_CODE_ENTRYPOINT: "cli" };
    const run = copy.run("hooks", ["Stop"], { cwd: plain, stdin: `not json ${secretText}`, env });
    expect(run).toMatchObject({ exitCode: 0, stdout: "" });
    const bad = copy.logged("hooks").filter((entry) => entry.event === "hook.bad-input");
    expect(bad.at(-1)).toMatchObject({ reason: "not JSON", bytes: 36 });
    expect(JSON.stringify(copy.logged("hooks"))).not.toContain(secretText);
  }, 20_000);
});
