import { closeSync, openSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { brokerEnv } from "../shared/broker-client.ts";
import { STARTED_HERE_VAR } from "../shared/scope.ts";

/** A session /new started: its process, and how it ends. */
export interface Launched {
  readonly pid: number;
  /** Its exit code. */
  readonly exited: Promise<number>;
}

/**
 * Starts a session in `projectDir` with its first message, and a workspace's other folders; see
 * launchSession().
 */
export type Launch = (
  sessionId: string,
  projectDir: string,
  message: string,
  addDirs: readonly string[],
) => Launched;

/** The shell a session starts through when the user database names none that runs. */
const FALLBACK_SHELL = "/bin/zsh";

/**
 * Your login shell, as the user database has it. Not os.userInfo().shell: Bun takes that from $SHELL,
 * which the broker's environment doesn't have ("unknown", F26). A shell that isn't an executable file
 * falls back to /bin/zsh. The broker asks once, when it starts.
 */
export function loginShell(user: string = userInfo().username): string {
  const read = Bun.spawnSync(["/usr/bin/dscl", ".", "-read", `/Users/${user}`, "UserShell"], {
    stderr: "ignore",
  });
  const shell = /^UserShell:\s*(\S+)\s*$/m.exec(read.stdout.toString())?.[1];
  return shell !== undefined && usableShell(shell) ? shell : FALLBACK_SHELL;
}

/** Whether `path` is an absolute path to a file someone may execute. */
export function usableShell(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() === true && (stat.mode & 0o111) !== 0;
}

/**
 * The command that starts a session (D11, plan 7.7): `claude -p` through your login shell, which gives
 * it the environment VS Code gives a panel. Its arguments come as "$@" and the message on stdin, so none
 * passes through the shell's parser. A workspace's other folders come as `--add-dir`, as in its window.
 */
export function sessionCommand(
  shell: string,
  sessionId: string,
  addDirs: readonly string[] = [],
): string[] {
  const dirs = addDirs.flatMap((dir) => ["--add-dir", dir]);
  return [
    shell,
    "-l",
    "-c",
    'exec claude -p "$@"',
    "claude-session",
    "--session-id",
    sessionId,
    ...dirs,
  ];
}

/**
 * Starts a session /new asked for, in a session of its own (setsid), so it outlives a broker restart.
 * Claude Code calls it sdk-cli (F27): its environment names its id, which is how the bridge's hooks know
 * to serve it (F25). Its stderr goes to `<logs>/sessions.log`; its stdout, Claude's text, goes nowhere:
 * the hooks send it.
 */
export function launchSession(logs: string, shell: string): Launch {
  return (sessionId, projectDir, message, addDirs) => {
    const stderr = openSync(join(logs, "sessions.log"), "a", 0o600);
    try {
      const child = Bun.spawn({
        cmd: sessionCommand(shell, sessionId, addDirs),
        cwd: projectDir,
        env: { ...brokerEnv(), SHELL: shell, [STARTED_HERE_VAR]: sessionId },
        detached: true,
        stdin: new TextEncoder().encode(message),
        stdout: "ignore",
        stderr,
      });
      child.unref();
      return { pid: child.pid, exited: child.exited };
    } finally {
      closeSync(stderr);
    }
  };
}
