import { closeSync, openSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { brokerEnv } from "../shared/broker-client.ts";

/** A session /new started: its process, and how it ends. */
export interface Launched {
  readonly pid: number;
  /** Its exit code. */
  readonly exited: Promise<number>;
}

/** Starts a session in `projectDir` with its first message; see launchSession(). */
export type Launch = (sessionId: string, projectDir: string, message: string) => Launched;

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
 * it the environment VS Code gives a panel. The id comes as "$1" and the message on stdin, so neither
 * passes through the shell's parser.
 */
export function sessionCommand(shell: string, sessionId: string): string[] {
  return [shell, "-l", "-c", 'exec claude -p --session-id "$1"', "claude-session", sessionId];
}

/**
 * Starts a session /new asked for, in a session of its own (setsid), so it outlives a broker restart.
 * Its entrypoint is `cli`, so the bridge's hooks serve it like a terminal session (F25). Its stderr
 * goes to `<logs>/sessions.log`; its stdout, Claude's text, goes nowhere: the hooks send it.
 */
export function launchSession(
  logs: string,
  shell: string,
): (sessionId: string, projectDir: string, message: string) => Launched {
  return (sessionId, projectDir, message) => {
    const stderr = openSync(join(logs, "sessions.log"), "a", 0o600);
    try {
      const child = Bun.spawn({
        cmd: sessionCommand(shell, sessionId),
        cwd: projectDir,
        env: { ...brokerEnv(), SHELL: shell, CLAUDE_CODE_ENTRYPOINT: "cli" },
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
