import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countOurs, type InstallPaths } from "../../src/ctl/install.ts";
import { type BridgePaths, installHooks, uninstallBridge } from "../../src/ctl/setup.ts";
import { noLog } from "../../src/shared/log.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { isDisabled, setDisabled } from "../../src/shared/state.ts";

// Plan 6.1: ctl uninstall in the order of design §6, with no broker running (tests/ctl/uninstall-process
// has one, and hooks waiting on it). The settings file is in a temp folder.
const root = mkdtempSync(join(tmpdir(), "tg-uninstall-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
let paths: BridgePaths;
let hooks: InstallPaths;
beforeEach(() => {
  count += 1;
  const repoRoot = join(root, `repo-${count}`);
  mkdirSync(repoRoot);
  const state = statePaths(repoRoot);
  hooks = {
    settingsFile: join(repoRoot, "settings.json"),
    backupDir: join(state.dir, "backups"),
    bun: process.execPath,
    repoRoot,
  };
  const launch = {
    bun: process.execPath,
    main: join(repoRoot, "main.ts"),
    launcher: join(repoRoot, "launch.ts"),
    bunfig: "",
    cwd: repoRoot,
  };
  paths = { hooks, state, launch };
  installHooks(hooks, false, noLog);
});
const settingsText = () => readFileSync(hooks.settingsFile, "utf8");

test("a dry run says what it would do, and does none of it", async () => {
  const before = settingsText();
  const outcome = await uninstallBridge(paths, true, noLog);
  expect(outcome).toEqual({
    ok: true,
    text: [
      "would set the disabled flag",
      `would remove 9 hooks from ${hooks.settingsFile}, only ours`,
      "no broker runs",
    ].join("\n"),
  });
  expect(isDisabled(paths.state)).toBe(false);
  expect(settingsText()).toBe(before);
});

test("the flag first, then only our hooks, then the broker: here, none runs", async () => {
  const outcome = await uninstallBridge(paths, false, noLog);
  expect(outcome.ok).toBe(true);
  expect(outcome.text.split("\n")).toEqual([
    "disabled: hooks do nothing now, and nothing starts the broker",
    `removed 9 hooks from ${hooks.settingsFile}`,
    expect.stringMatching(/^backup: .*settings\..*\.json$/),
    "the broker: not running",
  ]);
  expect(isDisabled(paths.state)).toBe(true);
  expect(countOurs(JSON.parse(settingsText()), hooks.repoRoot)).toBe(0);
});

test("settings that can't be written: the bridge stays disabled, and it says to run it again", async () => {
  const real = join(hooks.repoRoot, "real-settings.json");
  symlinkSync(real, `${hooks.settingsFile}.link`);
  const outcome = await uninstallBridge(
    { ...paths, hooks: { ...hooks, settingsFile: `${hooks.settingsFile}.link` } },
    false,
    noLog,
  );
  expect(outcome.ok).toBe(false);
  expect(outcome.text).toContain("symlink");
  expect(outcome.text).toContain("run 'bun run ctl uninstall' again");
  expect(isDisabled(paths.state)).toBe(true);
  expect(existsSync(real)).toBe(false);
});

test("install while the bridge is disabled says how to turn it on", () => {
  setDisabled(paths.state, true);
  const outcome = installHooks(hooks, false, noLog, isDisabled(paths.state));
  expect(outcome.text).toStartWith("already installed (9 hooks)");
  expect(outcome.text).toEndWith("'bun run ctl enable' turns it on");
  expect(installHooks(hooks, false, noLog, false).text).not.toContain("disabled");
});
