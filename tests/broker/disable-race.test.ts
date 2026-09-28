import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brokerEnv } from "../../src/shared/broker-client.ts";
import { ensureStateDir } from "../../src/shared/state.ts";
import { gone, RepoCopy } from "../helpers/repo-copy.ts";
import { FAKE_TOKEN } from "../helpers/secrets.ts";

// Findings of the Codex review of 2.3, each reproduced here before it was fixed.
const copy = new RepoCopy();
afterAll(() => copy.remove());
// Each test starts enabled, with no broker running, whatever the one before it left.
beforeEach(() => {
  copy.ctl("enable");
  copy.ctl("stop");
});

test("ctl disable while a broker is still starting: the broker doesn't stay up", async () => {
  // Hold broker.db, so that a starting broker waits between its first look at the disabled flag
  // and the moment it can be found (socket, pid file): the window the review pointed out.
  ensureStateDir(copy.state);
  const holder = new Database(copy.state.db, { create: true });
  holder.run("BEGIN EXCLUSIVE");
  const broker = Bun.spawn(copy.command("broker"), {
    cwd: copy.root,
    env: brokerEnv(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await Bun.sleep(400);
    expect(copy.ctl("disable").stdout).toBe("disabled; the broker: not running\n");
  } finally {
    holder.run("COMMIT");
    holder.close();
  }
  expect(await gone(broker.pid, 4000)).toBe(true);
  const stopped = copy.logged("broker").filter((entry) => entry.event === "broker.stopped");
  expect(stopped.at(-1)?.reason).toBe("disabled");
}, 20_000);

test("setting the disabled flag by hand stops a running broker within a few seconds", async () => {
  expect(copy.ctl("start").stdout).toMatch(/^started \(pid \d+\)/);
  const [pid] = copy.brokerPids();
  if (pid === undefined) throw new Error("no broker");
  writeFileSync(copy.state.disabled, "by hand\n");
  expect(await gone(pid, 5000)).toBe(true);
}, 20_000);

test("ctl status notices a replaced token: same bot, new secret in .env", async () => {
  expect(copy.ctl("start").stdout).toMatch(/^started \(pid \d+\)/);
  const envFile = join(copy.root, ".env");
  const original = readFileSync(envFile, "utf8");
  const botId = FAKE_TOKEN.split(":")[0];
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${botId}:${"R".repeat(35)}\n`);
  chmodSync(envFile, 0o600);
  try {
    expect(copy.ctl("status").stdout).toContain("with ANOTHER token than .env's");
  } finally {
    writeFileSync(envFile, original);
  }
  expect(copy.ctl("status").stdout).toContain("with this repo's token");
}, 20_000);
