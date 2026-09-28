import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { brokerEnv } from "../../src/shared/broker-client.ts";
import { Secret } from "../../src/shared/secret.ts";
import { gone, RepoCopy } from "../helpers/repo-copy.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";

// Plan 2.3's pass checks, run against a throwaway copy of the repo with a fake token.
const copy = new RepoCopy();
const repoA = join(copy.sandbox, "repo-a");
mkdirSync(repoA);
afterAll(() => copy.remove());

const hookEvents = (session: string) =>
  copy
    .logged("broker")
    .filter((entry) => entry.event === "hook.event" && entry.session === session);

/** /health, waiting up to `ms` for a broker that is still starting. */
async function healthWithin(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const health = await copy.health();
    if (health) return health;
    await Bun.sleep(50);
  }
  return undefined;
}

describe("one broker at a time", () => {
  test("ctl start twice leaves one broker, and /health answers", async () => {
    expect(copy.ctl("start").stdout).toMatch(/^started \(pid \d+\)/);
    expect(copy.ctl("start").stdout).toMatch(/^already running \(pid \d+\)/);
    const pids = copy.brokerPids();
    expect(pids).toHaveLength(1);
    expect(await copy.health()).toMatchObject({
      pid: pids[0],
      botId: 7777777777,
      tokenFingerprint: new Secret(FAKE_TOKEN).fingerprint(),
      schema: 1,
    });
    expect(copy.ctl("status").stdout).toContain("with this repo's token");
  }, 20_000);

  test("two brokers started at the same moment: one keeps running, the other leaves", async () => {
    expect(copy.ctl("stop").stdout).toMatch(/^stopped \(pid \d+\)/);
    const launch = () =>
      Bun.spawn(copy.command("broker"), {
        cwd: copy.root,
        env: brokerEnv(),
        stdio: ["ignore", "ignore", "ignore"],
      });
    const [first, second] = [launch(), launch()];
    const left = await Promise.race([
      first.exited.then(() => first),
      second.exited.then(() => second),
    ]);
    const kept = left === first ? second : first;
    expect(left.exitCode).toBe(0);
    expect((await healthWithin(3000))?.pid).toBe(kept.pid);
    expect(copy.brokerPids()).toEqual([kept.pid]);
    const refused = copy.logged("broker").filter((entry) => entry.event === "broker.not-started");
    expect(refused.at(-1)?.reason).toBe("another broker holds the lock");
    kept.kill();
    expect(await kept.exited).toBe(0);
  }, 20_000);
});

describe("a killed broker is restarted by the next hook, but not while disabled", () => {
  test("kill -9, then a hook from a served session starts a new one", async () => {
    copy.ctl("start");
    const [before] = copy.brokerPids();
    if (before === undefined) throw new Error("no broker to kill");
    process.kill(before, "SIGKILL");
    expect(await gone(before)).toBe(true);
    expect(await copy.health()).toBeUndefined();
    const run = copy.hook("SessionStart", repoA);
    expect(run).toMatchObject({ exitCode: 0, stdout: "" });
    const after = await copy.health();
    expect(after?.pid).toBeNumber();
    expect(after?.pid).not.toBe(before);
    expect(hookEvents(run.session)).toHaveLength(1);
  }, 20_000);

  test("disabled: the broker stops, hooks don't start it, ctl start refuses", async () => {
    expect(copy.ctl("disable").stdout).toMatch(/^disabled; the broker: stopped/);
    expect(copy.brokerPids()).toEqual([]);
    const run = copy.hook("SessionStart", repoA);
    expect(run).toMatchObject({ exitCode: 0, stdout: "" });
    await Bun.sleep(300);
    expect(copy.brokerPids()).toEqual([]);
    expect(hookEvents(run.session)).toEqual([]);
    expect(copy.ctl("start")).toMatchObject({
      exitCode: 1,
      stdout: expect.stringContaining("disabled"),
    });
    expect(copy.ctl("status").stdout).toStartWith("disabled:");
  }, 20_000);

  test("enabled again: the next hook starts it", async () => {
    expect(copy.ctl("enable").exitCode).toBe(0);
    const run = copy.hook("SessionStart", repoA);
    expect(run.exitCode).toBe(0);
    expect(await copy.health()).toBeDefined();
    expect(hookEvents(run.session)).toHaveLength(1);
  }, 20_000);
});

test("ctl stop, then status", async () => {
  expect(copy.ctl("stop").stdout).toMatch(/^stopped \(pid \d+\)/);
  expect(copy.brokerPids()).toEqual([]);
  expect(copy.ctl("stop").stdout).toBe("not running\n");
  expect(copy.ctl("status")).toMatchObject({
    exitCode: 1,
    stdout: expect.stringContaining("not running"),
  });
}, 20_000);
