import { userInfo } from "node:os";
import { join, resolve } from "node:path";

// Every path comes from this file's location, never from the session's current directory (design §3).
export const REPO_ROOT: string = resolve(import.meta.dir, "../..");
export const ENV_FILE: string = join(REPO_ROOT, ".env");
export const CONFIG_FILE: string = join(REPO_ROOT, "config.json");
export const BUNFIG_FILE: string = join(REPO_ROOT, "bunfig.toml");
export const BROKER_MAIN: string = join(REPO_ROOT, "src/broker/main.ts");

/** The home folder from the user database, not from $HOME, which a session's environment could set. */
export const HOME_DIR: string = userInfo().homedir;

/** Runtime state in <repo>/.state/, a 0700 folder that git ignores (design §5). */
export interface StatePaths {
  readonly dir: string;
  /** The broker's Unix socket (0600); there is no TCP port. */
  readonly socket: string;
  /** Held by the running broker: the single-instance lock. */
  readonly lock: string;
  readonly db: string;
  /** The running broker's pid, for `ctl stop` when the broker doesn't answer. */
  readonly pid: string;
  /** While this file exists, hooks do nothing and nothing starts the broker (D3). */
  readonly disabled: string;
  readonly logs: string;
}

export function statePaths(repoRoot: string): StatePaths {
  const dir = join(repoRoot, ".state");
  return {
    dir,
    socket: join(dir, "broker.sock"),
    lock: join(dir, "broker.lock"),
    db: join(dir, "broker.db"),
    pid: join(dir, "broker.pid"),
    disabled: join(dir, "disabled"),
    logs: join(dir, "logs"),
  };
}

export const STATE: StatePaths = statePaths(REPO_ROOT);
