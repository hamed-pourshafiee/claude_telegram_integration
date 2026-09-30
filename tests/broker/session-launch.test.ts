import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSession, sessionCommand } from "../../src/broker/session-launch.ts";

// Plan 7.7 (D11): the command that starts a session /new asked for, and the process it makes.
const dir = mkdtempSync(join(tmpdir(), "tg-launch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("claude -p through the login shell: the id as $1, never in the script", () => {
  expect(sessionCommand("/bin/zsh", "5e7d-uuid")).toEqual([
    "/bin/zsh",
    "-l",
    "-c",
    'exec claude -p --session-id "$1"',
    "claude-session",
    "5e7d-uuid",
  ]);
});

test("the process: in the folder, in a session of its own, the message on stdin, a clean environment", async () => {
  // A stand-in login shell: it records what it got, as claude would have got it after the exec.
  const shell = join(dir, "shell.sh");
  const record = join(dir, "record.txt");
  writeFileSync(
    shell,
    `#!/bin/sh
{ echo "args: $*"; echo "cwd: $(pwd -P)"; env | sort; echo "stdin: $(cat)"; } > "${record}"
echo "a warning" >&2
exit 3
`,
    { mode: 0o755 },
  );
  const folder = mkdtempSync(join(dir, "project-"));
  const launched = launchSession(dir, shell)("5e7d-uuid", folder, "📨 From Hamed on Telegram: hi");
  expect(await launched.exited).toBe(3);
  const seen = readFileSync(record, "utf8");
  expect(seen).toContain('args: -l -c exec claude -p --session-id "$1" claude-session 5e7d-uuid');
  expect(seen).toContain(`cwd: ${realpathSync(folder)}`);
  expect(seen).toContain("stdin: 📨 From Hamed on Telegram: hi");
  expect(seen).toContain("CLAUDE_CODE_ENTRYPOINT=cli");
  expect(seen).toContain(`SHELL=${shell}`);
  const names = [...seen.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
  const shellOwn = ["PWD", "SHLVL", "_", "OLDPWD"];
  expect(names.filter((name) => !shellOwn.includes(name ?? "")).sort()).toEqual([
    "CLAUDE_CODE_ENTRYPOINT",
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
  ]);
  expect(readFileSync(join(dir, "sessions.log"), "utf8")).toBe("a warning\n");
});

test("it leads a process group of its own (setsid), so a broker restart leaves it", async () => {
  const shell = join(dir, "group.sh");
  const record = join(dir, "group.txt");
  writeFileSync(shell, `#!/bin/sh\necho "$$ $(ps -o pgid= -p $$)" > "${record}"\n`, {
    mode: 0o755,
  });
  await launchSession(dir, shell)("id", dir, "").exited;
  const [pid, group] = readFileSync(record, "utf8").trim().split(/\s+/);
  expect(group).toBe(pid);
});
