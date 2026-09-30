import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/shared/config.ts";
import {
  contentModeFor,
  isInside,
  sessionEnv,
  sessionScope,
  startedHere,
} from "../../src/shared/scope.ts";

// Real folders, so that symlinks resolve: <root>/home/{bridge/sandbox, work, other}
const root = realpathSync(mkdtempSync(join(tmpdir(), "tg-scope-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const repo = join(home, "bridge");
for (const folder of ["bridge/sandbox/app", "bridge/sandbox-2", "work/client", "other"]) {
  mkdirSync(join(home, folder), { recursive: true });
}
const places = { repoRoot: repo, home };
const defaults = parseConfig({}, places);
const wide = parseConfig({ serve: ["~"], skip: ["~/work"] }, places);
const panel = (projectDir: string | undefined) => ({ projectDir, entrypoint: "claude-vscode" });

describe("with the defaults, only sessions started in sandbox/ are served", () => {
  test.each([
    ["sandbox/ itself", join(repo, "sandbox")],
    ["a folder inside it", join(repo, "sandbox/app")],
  ])("serves %s", (_name, dir) => {
    expect(sessionScope(defaults, panel(dir))).toEqual({ served: true });
  });

  test.each([
    ["the repo root, where the build session runs", repo, "outside the served folders"],
    ["a sibling whose name starts the same", join(repo, "sandbox-2"), "outside the served folders"],
    ["another repo", join(home, "other"), "outside the served folders"],
    ["a relative path", "sandbox", "not an absolute path"],
    ["no CLAUDE_PROJECT_DIR", undefined, "not an absolute path"],
  ])("not %s", (_name, dir, reason) => {
    expect(sessionScope(defaults, panel(dir))).toEqual({
      served: false,
      reason: expect.stringContaining(reason),
    });
  });

  test.each([
    ["claude-vscode", true],
    ["cli", true],
    ["sdk-cli", false],
    [undefined, false],
  ])("entrypoint %p served: %p", (entrypoint, served) => {
    const scope = sessionScope(defaults, { projectDir: join(repo, "sandbox"), entrypoint });
    expect(scope.served).toBe(served);
  });
});

describe("skip list and symlinks", () => {
  test("skip wins over serve", () => {
    expect(sessionScope(wide, panel(join(home, "work/client")))).toEqual({
      served: false,
      reason: "started in a skipped folder",
    });
    expect(sessionScope(wide, panel(join(home, "other")))).toEqual({ served: true });
  });

  test("a symlink into a served folder counts as inside it", () => {
    const link = join(root, "link-to-sandbox");
    symlinkSync(join(repo, "sandbox"), link);
    expect(sessionScope(defaults, panel(link))).toEqual({ served: true });
  });

  test("a symlink into a skipped folder is skipped", () => {
    const link = join(root, "link-to-work");
    symlinkSync(join(home, "work"), link);
    expect(sessionScope(wide, panel(link)).served).toBe(false);
  });

  test("isInside compares whole path segments", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a/..b", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});

describe("a start folder that no longer exists fails closed (Codex review of 2.1)", () => {
  // As on macOS, where /tmp is a symlink to /private/tmp. The session started in <root>/tmp/project,
  // since deleted: its path no longer resolves, while the skipped folder's does.
  const privateTmp = join(root, "private-tmp");
  const tmp = join(root, "tmp");
  mkdirSync(privateTmp);
  symlinkSync(privateTmp, tmp);
  const gone = join(tmp, "project");
  const config = parseConfig(
    { serve: [root], skip: [tmp], content: { default: "full", pingOnly: [tmp] } },
    places,
  );

  test("it is not served", () => {
    expect(sessionScope(config, panel(gone))).toEqual({
      served: false,
      reason: "the start folder no longer exists",
    });
  });

  test("its text stays on the Mac", () => {
    expect(contentModeFor(config, gone)).toBe("ping-only");
  });
});

// The recorded paths start with ~ (redacted); here ~ is a temp folder with the same layout.
const fixtureHome = join(root, "fixture-home");
const fixtureRepo = join(fixtureHome, "src/bc/claude_telegram_integration");
mkdirSync(join(fixtureRepo, "sandbox"), { recursive: true });

/** Start folder, entrypoint and cwd of a recorded hook input, with ~ as `fixtureHome`. */
function recorded(name: string): { projectDir: string; entrypoint: string; cwd: string } {
  const path = join(import.meta.dir, "../fixtures/hooks", name);
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const input = data.input as Record<string, unknown> | undefined;
  const { projectDir, entrypoint } = data;
  const cwd = input?.cwd;
  if (typeof projectDir !== "string" || typeof entrypoint !== "string" || typeof cwd !== "string") {
    throw new Error(`${name} lacks projectDir, entrypoint or input.cwd`);
  }
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, fixtureHome);
  return { projectDir: expand(projectDir), entrypoint, cwd: expand(cwd) };
}

describe("recorded sessions: the start folder decides, not the cwd (F15)", () => {
  const config = parseConfig(
    { entrypoints: ["cli", "sdk-cli"] },
    { repoRoot: fixtureRepo, home: fixtureHome },
  );

  test("started in the repo, then cd'd into sandbox/: not served", () => {
    const session = recorded("sdk-cli/Stop-after-cd.json");
    expect(session.cwd).toBe(join(fixtureRepo, "sandbox"));
    expect(sessionScope(config, session)).toEqual({
      served: false,
      reason: "started outside the served folders",
    });
  });

  test("started in sandbox/: served", () => {
    expect(sessionScope(config, recorded("cli/Stop.json"))).toEqual({ served: true });
  });

  test("sessionEnv reads only CLAUDE_PROJECT_DIR and CLAUDE_CODE_ENTRYPOINT", () => {
    const env = { CLAUDE_PROJECT_DIR: "/a", CLAUDE_CODE_ENTRYPOINT: "cli", PWD: "/a/sandbox" };
    expect(sessionEnv(env)).toEqual({ projectDir: "/a", entrypoint: "cli" });
  });
});

describe("content policy (D8)", () => {
  test("full by default; ping-only everywhere when content.default says so", () => {
    expect(contentModeFor(defaults, join(repo, "sandbox"))).toBe("full");
    const pingOnly = parseConfig({ content: { default: "ping-only" } }, places);
    expect(contentModeFor(pingOnly, join(repo, "sandbox"))).toBe("ping-only");
  });

  test("full, except in the ping-only folders", () => {
    const config = parseConfig({ content: { default: "full", pingOnly: ["~/work"] } }, places);
    expect(contentModeFor(config, join(home, "work/client"))).toBe("ping-only");
    expect(contentModeFor(config, join(home, "other"))).toBe("full");
  });
});

describe("a session /new started (D11, plan 7.7)", () => {
  test("its environment names its own id: served though Claude Code calls it sdk-cli (F27)", () => {
    const env = { CLAUDE_TELEGRAM_SESSION: "5e7d-uuid", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
    expect(startedHere(env, "5e7d-uuid")).toBe(true);
    const session = { projectDir: join(repo, "sandbox"), entrypoint: "sdk-cli" };
    expect(sessionScope(defaults, session, true)).toEqual({ served: true });
  });

  test("another session's id, none, or an empty one: an sdk-cli session stays unserved", () => {
    expect(startedHere({ CLAUDE_TELEGRAM_SESSION: "5e7d-uuid" }, "other")).toBe(false);
    expect(startedHere({}, "5e7d-uuid")).toBe(false);
    expect(startedHere({ CLAUDE_TELEGRAM_SESSION: "" }, "")).toBe(false);
  });

  test("its folder must still be served, and not skipped", () => {
    const skipped = { projectDir: join(home, "work/client"), entrypoint: "sdk-cli" };
    expect(sessionScope(wide, skipped, true).served).toBe(false);
  });
});
