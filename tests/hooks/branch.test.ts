import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBranch } from "../../src/hooks/branch.ts";

// The branch for session labels, read from HEAD without running git in the session's repo.
const dir = mkdtempSync(join(tmpdir(), "tg-branch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function repo(name: string, head: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), `${head}\n`);
  return root;
}

test("a branch, from the repo's root or a folder inside it", () => {
  const root = repo("plain", "ref: refs/heads/feature/login");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  expect(gitBranch(root)).toBe("feature/login");
  expect(gitBranch(join(root, "src", "deep"))).toBe("feature/login");
});

test("a detached HEAD gives the short commit", () => {
  expect(gitBranch(repo("detached", "0123456789abcdef0123456789abcdef01234567"))).toBe("0123456");
});

test("a worktree's .git file points to its git directory", () => {
  const main = repo("main", "ref: refs/heads/main");
  const gitDir = join(main, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
  const worktree = join(dir, "wt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  expect(gitBranch(worktree)).toBe("wt-branch");
});

test("outside a repo, or a HEAD it can't read: undefined", () => {
  const outside = join(dir, "not-a-repo");
  mkdirSync(outside);
  expect(gitBranch(outside)).toBeUndefined();
  expect(gitBranch(repo("odd", "something else"))).toBeUndefined();
});
