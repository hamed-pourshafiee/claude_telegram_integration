import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// Anchored to this file, not the cwd (design §3).
const repoRoot = dirname(import.meta.dir);

/** Whether git ignores `path` (relative to the repo root), whether or not it exists or is tracked. */
function isIgnored(path: string): boolean {
  const result = Bun.spawnSync(["git", "check-ignore", "--quiet", "--no-index", path], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git check-ignore ${path} exited ${result.exitCode}: ${result.stderr.toString()}`,
  );
}

describe(".gitignore keeps secrets and runtime state out of git", () => {
  test.each([
    ".env",
    ".env.local",
    ".state/broker.sock",
    ".state/backups/settings.json",
    "sandbox/notes.md",
    "node_modules/typescript/package.json",
    "CLAUDE.local.md",
  ])("ignores %s", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  test.each([".env.example", "CLAUDE.md", "src/broker/main.ts", "project-docs/progress.md"])(
    "tracks %s",
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );
});

// implementation-plan §1: files ≤ 300 lines. Function length is checked by Biome.
test("no TypeScript file is longer than 300 lines", async () => {
  const scanned: string[] = [];
  const tooLong: string[] = [];
  for await (const path of new Bun.Glob("{src,tests,scripts}/**/*.ts").scan({ cwd: repoRoot })) {
    const text = await Bun.file(join(repoRoot, path)).text();
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    scanned.push(path);
    if (lines > 300) tooLong.push(`${path} (${lines} lines)`);
  }
  expect(scanned).toContain("tests/scaffold.test.ts");
  expect(tooLong).toEqual([]);
});
