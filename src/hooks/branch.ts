import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The branch of the git repo that holds `dir`, read from HEAD by hand: running git in another repo
 * could run that repo's configured programs, and none of its code may run (F13, F14). A detached HEAD
 * gives the short commit; outside a repo, undefined. Unreadable files throw, for the caller to log.
 */
export function gitBranch(dir: string): string | undefined {
  let current = resolve(dir);
  for (let depth = 0; depth < 100; depth += 1) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) return headOf(dotGit);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** HEAD's branch; `.git` is the git directory, or a file that points to it (a worktree). */
function headOf(dotGit: string): string | undefined {
  let gitDir = dotGit;
  if (!statSync(dotGit).isDirectory()) {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (pointer === undefined) return undefined;
    gitDir = resolve(dirname(dotGit), pointer);
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch !== undefined) return branch;
  return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined;
}
