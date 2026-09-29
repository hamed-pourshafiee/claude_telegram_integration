import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countOurs, hookGroups, writeAtomically } from "../../src/ctl/install.ts";
import { installHooks, uninstallHooks } from "../../src/ctl/setup.ts";
import { noLog } from "../../src/shared/log.ts";

// Plan 2.7's pass checks for ctl install and uninstall, on a settings file in a temp folder.
const dir = mkdtempSync(join(tmpdir(), "tg-install-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const repoRoot = "/Users/someone/src/claude_telegram_integration";
const bun = "/Users/someone/.bun/bin/bun";
const theirs = {
  type: "command",
  command: "/Users/someone/.claude/hooks/codex-checkpoint-code.sh",
};
// An empty list of an event we don't use stays. (One of ours, left empty by uninstall, goes: the same
// thing to Claude Code.)
const ORIGINAL = `${JSON.stringify(
  { theme: "dark", hooks: { Stop: [{ hooks: [theirs] }], SubagentStop: [] } },
  null,
  2,
)}\n`;

let count = 0;
let paths: { settingsFile: string; backupDir: string; bun: string; repoRoot: string };
beforeEach(() => {
  count += 1;
  const settingsFile = join(dir, `settings-${count}.json`);
  writeFileSync(settingsFile, ORIGINAL, { mode: 0o644 });
  paths = { settingsFile, backupDir: join(dir, `backups-${count}`), bun, repoRoot };
});
const settings = () => JSON.parse(readFileSync(paths.settingsFile, "utf8"));

describe("our entries (design §3)", () => {
  test("each runs Bun by absolute path with --no-env-file and our bunfig.toml (F13, F14)", () => {
    const groups = hookGroups(bun, repoRoot);
    expect(Object.keys(groups)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "Notification",
      "PermissionRequest",
      "StopFailure",
      "PreToolUse",
      "PostToolUse",
      "SessionEnd",
    ]);
    for (const [event, [group]] of Object.entries(groups)) {
      const waits = ["Stop", "PreToolUse", "PermissionRequest"];
      const flag = waits.includes(event) ? " --wait" : "";
      expect(group?.hooks).toEqual([
        expect.objectContaining({
          type: "command",
          command: `${bun} --no-env-file --config=${repoRoot}/bunfig.toml ${repoRoot}/src/hooks/main.ts ${event}${flag}`,
        }),
      ]);
    }
    // Phase 3: only a Stop hook that can wake Claude (asyncRewake) waits for a reply (--wait).
    expect(groups.Stop?.[0]?.hooks).toEqual([
      expect.objectContaining({ asyncRewake: true, timeout: 43_200 }),
    ]);
    expect(groups.Stop?.[0]?.hooks).not.toEqual([expect.objectContaining({ async: true })]);
    expect(groups.Notification?.[0]).toMatchObject({ matcher: "idle_prompt" });
  });

  test("phase 4: the question hook waits for your answers or approval, and PostToolUse closes the call", () => {
    const groups = hookGroups(bun, repoRoot);
    expect(groups.PreToolUse?.[0]).toMatchObject({ matcher: "AskUserQuestion|ExitPlanMode" });
    // Sync, so Claude waits for its answers; up to 12 h, with a spinner saying where they may come from.
    expect(groups.PreToolUse?.[0]?.hooks).toEqual([
      expect.objectContaining({
        timeout: 43_200,
        statusMessage: expect.stringContaining("Telegram"),
      }),
    ]);
    expect(groups.PreToolUse?.[0]?.hooks).not.toEqual([expect.objectContaining({ async: true })]);
    expect(groups.PostToolUse?.[0]).toMatchObject({ matcher: "AskUserQuestion|ExitPlanMode" });
    expect(groups.PostToolUse?.[0]?.hooks).toEqual([expect.objectContaining({ async: true })]);
  });

  test("a path that would need shell quoting is refused", () => {
    expect(() => hookGroups("/Users/some one/bun", repoRoot)).toThrow("shell quoting");
    expect(() => hookGroups(bun, "relative/path")).toThrow("shell quoting");
  });
});

test("phase 5: the PermissionRequest hook waits for your decision, for every tool (it picks)", () => {
  const groups = hookGroups(bun, repoRoot);
  expect(groups.PermissionRequest?.[0]).not.toHaveProperty("matcher");
  expect(groups.PermissionRequest?.[0]?.hooks).toEqual([
    expect.objectContaining({ timeout: 43_200 }),
  ]);
  expect(groups.PermissionRequest?.[0]?.hooks).not.toEqual([
    expect.objectContaining({ async: true }),
  ]);
});

describe("install and uninstall", () => {
  test("installing twice leaves one set; the other hooks stay; a backup is kept", () => {
    expect(installHooks(paths, false, noLog)).toMatchObject({ ok: true });
    expect(installHooks(paths, false, noLog)).toMatchObject({
      text: expect.stringContaining("already"),
    });
    expect(countOurs(settings(), repoRoot)).toBe(9);
    expect(settings().hooks.Stop[0]).toEqual({ hooks: [theirs] });
    expect(settings().theme).toBe("dark");
    const backups = readdirSync(paths.backupDir);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(paths.backupDir, backups[0] ?? ""), "utf8")).toBe(ORIGINAL);
    expect(statSync(join(paths.backupDir, backups[0] ?? "")).mode & 0o777).toBe(0o600);
    expect(statSync(paths.settingsFile).mode & 0o777).toBe(0o644);
  });

  test("uninstalling removes only ours and keeps an edit made after install", () => {
    installHooks(paths, false, noLog);
    const edited = settings();
    edited.model = "opus";
    edited.hooks.Stop.push({ hooks: [{ type: "command", command: "/usr/local/bin/notify" }] });
    writeFileSync(paths.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
    expect(uninstallHooks(paths, false, noLog)).toMatchObject({ ok: true });
    expect(countOurs(settings(), repoRoot)).toBe(0);
    expect(settings().model).toBe("opus");
    expect(settings().hooks.Stop).toEqual([
      { hooks: [theirs] },
      { hooks: [{ type: "command", command: "/usr/local/bin/notify" }] },
    ]);
  });

  test("install then uninstall, nothing else changed: byte for byte the file from before", () => {
    installHooks(paths, false, noLog);
    uninstallHooks(paths, false, noLog);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(ORIGINAL);
  });

  test("a dry run shows the entries and changes nothing", () => {
    const plan = installHooks(paths, true, noLog);
    expect(plan.text).toContain(`${repoRoot}/src/hooks/main.ts SessionStart`);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(ORIGINAL);
    expect(existsSync(paths.backupDir)).toBe(false);
  });
});

describe("refusals", () => {
  test("a symlinked settings file is not replaced", () => {
    const link = join(dir, `link-${count}.json`);
    symlinkSync(paths.settingsFile, link);
    expect(installHooks({ ...paths, settingsFile: link }, false, noLog)).toMatchObject({
      ok: false,
      text: expect.stringContaining("symlink"),
    });
  });

  test("a file that changed since it was read is not overwritten", () => {
    expect(() => writeAtomically(paths.settingsFile, "{}\n", "something else")).toThrow("changed");
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(ORIGINAL);
  });

  test("no settings file yet: install creates one", () => {
    rmSync(paths.settingsFile);
    expect(installHooks(paths, false, noLog)).toMatchObject({ ok: true });
    expect(countOurs(settings(), repoRoot)).toBe(9);
  });
});
