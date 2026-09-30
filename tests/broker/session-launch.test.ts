import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchSession,
  loginShell,
  sessionCommand,
  usableShell,
} from "../../src/broker/session-launch.ts";
import { brokerEnv } from "../../src/shared/broker-client.ts";

// Plan 7.7 (D11): the command that starts a session /new asked for, and the process it makes.
const dir = mkdtempSync(join(tmpdir(), "tg-launch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("claude -p through the login shell: its arguments as $@, never in the script", () => {
  expect(sessionCommand("/bin/zsh", "5e7d-uuid", ["/w/api", "/w/web"])).toEqual([
    "/bin/zsh",
    "-l",
    "-c",
    'exec claude -p "$@"',
    "claude-session",
    "--session-id",
    "5e7d-uuid",
    "--add-dir",
    "/w/api",
    "--add-dir",
    "/w/web",
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
  const launch = launchSession(dir, shell);
  const launched = launch("5e7d-uuid", folder, "📨 From Hamed on Telegram: hi", ["/w/api"]);
  expect(await launched.exited).toBe(3);
  const seen = readFileSync(record, "utf8");
  expect(seen).toContain(
    'args: -l -c exec claude -p "$@" claude-session --session-id 5e7d-uuid --add-dir /w/api',
  );
  expect(seen).toContain(`cwd: ${realpathSync(folder)}`);
  expect(seen).toContain("stdin: 📨 From Hamed on Telegram: hi");
  // Its id, which tells the hooks to serve it: Claude Code calls it sdk-cli (F27).
  expect(seen).toContain("CLAUDE_TELEGRAM_SESSION=5e7d-uuid");
  expect(seen).toContain(`SHELL=${shell}`);
  const names = [...seen.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
  const shellOwn = ["PWD", "SHLVL", "_", "OLDPWD"];
  expect(names.filter((name) => !shellOwn.includes(name ?? "")).sort()).toEqual([
    "CLAUDE_TELEGRAM_SESSION",
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
  await launchSession(dir, shell)("id", dir, "", []).exited;
  const [pid, group] = readFileSync(record, "utf8").trim().split(/\s+/);
  expect(group).toBe(pid);
});

test("the login shell comes from the user database, in the broker's own environment too (F26)", () => {
  const module = join(import.meta.dir, "../../src/broker/session-launch.ts");
  const script = `import { loginShell } from ${JSON.stringify(module)}; console.log(loginShell());`;
  // The broker's environment has no SHELL, so os.userInfo().shell would be "unknown" there.
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: brokerEnv() });
  const shell = run.stdout.toString().trim();
  expect(shell).toMatch(/^\/.+/);
  expect(shell).not.toBe("unknown");
  const database = Bun.spawnSync([
    "/usr/bin/dscl",
    ".",
    "-read",
    `/Users/${brokerEnv().USER}`,
    "UserShell",
  ]);
  expect(database.stdout.toString()).toContain(shell);
  expect(loginShell("no-such-user-here")).toBe("/bin/zsh");
});

test("a shell is used only if it's an absolute path to an executable file", () => {
  expect(usableShell("/bin/zsh")).toBe(true);
  for (const path of ["unknown", "bin/zsh", "/etc/hosts", "/bin", "/no/such/shell"]) {
    expect(usableShell(path)).toBe(false);
  }
});
