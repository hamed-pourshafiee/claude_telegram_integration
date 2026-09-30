import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../../src/broker/db.ts";
import { formatChecks } from "../../src/ctl/doctor.ts";
import {
  type LocalPaths,
  localChecks,
  RECENT_STOPS,
  TESTED_CLAUDE_CODE,
} from "../../src/ctl/doctor-local.ts";
import { hookGroups } from "../../src/ctl/install.ts";
import { installHooks } from "../../src/ctl/setup.ts";
import { brokerEnv } from "../../src/shared/broker-client.ts";
import { loadBotToken, TOKEN_KEY } from "../../src/shared/env.ts";
import { noLog } from "../../src/shared/log.ts";
import { REPO_ROOT, statePaths } from "../../src/shared/paths.ts";
import { ensureStateDir, setDisabled } from "../../src/shared/state.ts";
import { expectNoLeak, FAKE_TOKEN } from "../helpers/secrets.ts";

// Plan 6.1: ctl doctor's checks of this Mac's side, each on a repo folder of its own. A running broker
// is a stand-in that answers /health on the folder's socket.
const root = mkdtempSync(join(tmpdir(), "tg-dl-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;

/** A repo folder with a private .env and .state/, and a settings file of its own (none yet). */
function setup(): LocalPaths {
  count += 1;
  const repoRoot = join(root, `r${count}`);
  mkdirSync(repoRoot);
  const envFile = join(repoRoot, ".env");
  writeFileSync(envFile, `${TOKEN_KEY}=${FAKE_TOKEN}\n`, { mode: 0o600 });
  const state = statePaths(repoRoot);
  ensureStateDir(state);
  const settingsFile = join(repoRoot, "settings.json");
  return { state, envFile, settingsFile, bun: process.execPath, repoRoot };
}

/** The named check of the doctor's run; no line of it shows the token. */
async function check(paths: LocalPaths, name: string) {
  const checks = await localChecks(paths);
  expectNoLeak(formatChecks(checks));
  const found = checks.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

/** A stand-in broker whose /health reports `fields` over the other ones of a good broker. */
function fakeBroker(paths: LocalPaths, fields: Record<string, unknown> = {}) {
  const health = {
    ok: true,
    pid: 4321,
    startedAt: new Date().toISOString(),
    uptimeSeconds: 7300,
    botId: 7777777777,
    tokenFingerprint: loadBotToken(paths.envFile).fingerprint(),
    schema: SCHEMA_VERSION,
    envKeys: Object.keys(brokerEnv()),
    paired: null,
    pairingUntil: null,
    polling: false,
    ...fields,
  };
  return Bun.serve({ unix: paths.state.socket, fetch: () => Response.json(health) });
}

describe("broker", () => {
  test("not running is fine: the next hook starts it", async () => {
    expect(await check(setup(), "broker")).toEqual({
      ok: true,
      name: "broker",
      detail: "not running; the next hook starts it",
    });
  });

  test("running with this repo's token, this code's schema and nothing else in its environment", async () => {
    const paths = setup();
    const server = fakeBroker(paths);
    const detail = `pid 4321, up 2 h, schema ${SCHEMA_VERSION}, with this repo's token and a clean environment`;
    expect(await check(paths, "broker")).toMatchObject({ ok: true, detail });
    server.stop(true);
  });

  test("another token, an older schema and a stray variable are each named", async () => {
    const paths = setup();
    const envKeys = [...Object.keys(brokerEnv()), "NODE_OPTIONS"];
    const server = fakeBroker(paths, { tokenFingerprint: "0000", schema: 1, envKeys });
    const { ok, detail } = await check(paths, "broker");
    expect(ok).toBe(false);
    expect(detail).toContain("ANOTHER token than .env's");
    expect(detail).toContain(`this code needs schema ${SCHEMA_VERSION}`);
    expect(detail).toContain("variables it should not have: NODE_OPTIONS");
    server.stop(true);
  });

  test("disabled: it says how to turn the bridge on", async () => {
    const paths = setup();
    setDisabled(paths.state, true);
    expect(await check(paths, "broker")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ctl enable"),
    });
  });
});

describe("state", () => {
  test(".state/ and its folders 0700, what is in them 0600; spikes/ is not looked into", async () => {
    const paths = setup();
    writeFileSync(join(paths.state.logs, "hooks.log"), "", { mode: 0o600 });
    mkdirSync(join(paths.state.dir, "spikes"), { mode: 0o700 });
    writeFileSync(join(paths.state.dir, "spikes", "s1.json"), "{}", { mode: 0o644 });
    expect(await check(paths, "state")).toMatchObject({ ok: true });
  });

  test("a log or a folder open to others is named", async () => {
    const paths = setup();
    writeFileSync(join(paths.state.logs, "hooks.log"), "", { mode: 0o644 });
    chmodSync(paths.state.logs, 0o755);
    const { ok, detail } = await check(paths, "state");
    expect(ok).toBe(false);
    expect(detail).toContain(".state/logs 755");
    expect(detail).toContain(".state/logs/hooks.log 644");
  });

  test("no .state/ yet: fine, the broker makes it", async () => {
    const paths = setup();
    rmSync(paths.state.dir, { recursive: true });
    expect(await check(paths, "state")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("no .state/"),
    });
  });
});

describe("hooks and bun", () => {
  test("not installed; the Bun is ctl's", async () => {
    const paths = setup();
    expect(await check(paths, "hooks")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ctl install"),
    });
    const version = Bun.version;
    expect(await check(paths, "bun")).toMatchObject({
      ok: true,
      detail: `ctl runs ${process.execPath} ${version}`,
    });
  });

  test("installed by this version; the Bun is the hooks'", async () => {
    const paths = setup();
    installHooks({ ...paths, backupDir: join(paths.repoRoot, "backups") }, false, noLog);
    expect(await check(paths, "hooks")).toMatchObject({
      ok: true,
      detail: "9 installed, as this version installs them",
    });
    expect(await check(paths, "bun")).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^the hooks run /),
    });
  });

  test("installed by an older version: not as this one installs them", async () => {
    const paths = setup();
    const groups = { ...hookGroups(paths.bun, paths.repoRoot) };
    // Phase 4's PermissionRequest hook: only the ping, in the background.
    const [old] = groups.PermissionRequest ?? [];
    const command = `${paths.bun} --no-env-file --config=${paths.repoRoot}/bunfig.toml ${paths.repoRoot}/src/hooks/main.ts PermissionRequest`;
    groups.PermissionRequest = [
      { ...old, hooks: [{ type: "command", command, timeout: 10, async: true }] },
    ];
    writeFileSync(paths.settingsFile, JSON.stringify({ hooks: groups }));
    const { ok, detail } = await check(paths, "hooks");
    expect(ok).toBe(false);
    expect(detail).toBe(
      "9 of ours, not as this version installs them: see 'bun run ctl install --dry-run'",
    );
  });

  test("hooks that name a Bun no longer there", async () => {
    const paths = setup();
    const gone = join(paths.repoRoot, "old-bun", "bun");
    writeFileSync(paths.settingsFile, JSON.stringify({ hooks: hookGroups(gone, paths.repoRoot) }));
    expect(await check(paths, "hooks")).toMatchObject({ ok: true });
    expect(await check(paths, "bun")).toMatchObject({
      ok: false,
      detail: expect.stringContaining(`${gone}, which is not there`),
    });
  });

  test("a settings file that isn't JSON", async () => {
    const paths = setup();
    writeFileSync(paths.settingsFile, "{ not json");
    expect(await check(paths, "hooks")).toMatchObject({
      ok: false,
      detail: expect.stringContaining(paths.settingsFile),
    });
  });
});

/** hooks.log lines for stops, as the Stop hook writes them. */
function stops(outcomes: readonly (readonly [string, string, string?])[]): string {
  return outcomes
    .map(([outcome, reason, version]) => {
      const fields = { session: "s", generation: 1, outcome, reason, chars: 5, tasks: 0 };
      const named = version === undefined ? {} : { version };
      return `${JSON.stringify({ ...fields, ...named, t: "", source: "hook", pid: 1, event: "hook.stop" })}\n`;
    })
    .join("");
}

const FINISH = ["finish", "no continuation entry", "2.1.284"] as const;
const CONTINUING = ["continuing", "continuation entry", "2.1.283"] as const;
const MISSED = ["unknown", "no summary in time", "2.1.284"] as const;

describe("stops (F16)", () => {
  test("none logged yet", async () => {
    expect(await check(setup(), "stops")).toMatchObject({ ok: true, detail: "none logged yet" });
  });

  test("the latest read, with the versions they name, and an untested one marked", async () => {
    const paths = setup();
    const lines = [
      ...Array(8).fill(FINISH),
      CONTINUING,
      ["finish", "no continuation entry", "2.1.300"],
    ];
    writeFileSync(join(paths.state.logs, "hooks.log"), stops(lines));
    const detail = `the last ${RECENT_STOPS} read: 9 finished, 1 continuing; Claude Code 2.1.284, 2.1.283, 2.1.300 (not tested: 2.1.300)`;
    expect(await check(paths, "stops")).toMatchObject({ ok: true, detail });
  });

  test("a stop whose summary didn't come in time fails, even from the rotated copy", async () => {
    const paths = setup();
    writeFileSync(join(paths.state.logs, "hooks.log.1"), stops([MISSED, FINISH]));
    writeFileSync(join(paths.state.logs, "hooks.log"), stops(Array(8).fill(FINISH)));
    const { ok, detail } = await check(paths, "stops");
    expect(ok).toBe(false);
    expect(detail).toStartWith(`1 of the last ${RECENT_STOPS} had no summary in time`);
  });

  test("an old miss, past the latest stops, no longer counts", async () => {
    const paths = setup();
    writeFileSync(join(paths.state.logs, "hooks.log.1"), stops([MISSED]));
    writeFileSync(join(paths.state.logs, "hooks.log"), stops(Array(RECENT_STOPS).fill(FINISH)));
    expect(await check(paths, "stops")).toMatchObject({ ok: true });
  });
});

test("the README names every Claude Code version the doctor counts as tested", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const version of TESTED_CLAUDE_CODE) expect(readme).toContain(version);
});
