// A throwaway copy of this repo's runtime files (src/, bunfig.toml, and a .env with a fake token) in a
// temp folder. Its broker, hooks and ctl run for real, as separate processes with their own .state/:
// never this repo's broker, state or token.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrokerHealth, brokerHealth } from "../../src/shared/broker-client.ts";
import { asFields, type Fields } from "../../src/shared/json.ts";
import { noLog } from "../../src/shared/log.ts";
import { REPO_ROOT, type StatePaths, statePaths } from "../../src/shared/paths.ts";
import { FAKE_TOKEN } from "./secrets.ts";

export interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/** Just enough environment to run Bun. */
export const BASE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/bin:/bin",
  HOME: process.env.HOME ?? "",
};

export class RepoCopy {
  readonly root: string = realpathSync(mkdtempSync(join(tmpdir(), "tg-copy-")));
  readonly sandbox: string = join(this.root, "sandbox");
  readonly state: StatePaths = statePaths(this.root);
  readonly brokerMain: string = join(this.root, "src/broker/main.ts");
  readonly brokerLauncher: string = join(this.root, "src/broker/launch.ts");
  #sessions = 0;

  /**
   * `apiBase`: the copy's Telegram client talks to that stand-in (tests/helpers/fake-telegram.ts), so
   * its broker may be paired. Without it, keep the copy unpaired: nothing may reach Telegram.
   */
  constructor(options: { readonly apiBase?: string } = {}) {
    cpSync(join(REPO_ROOT, "src"), join(this.root, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "bunfig.toml"), join(this.root, "bunfig.toml"));
    const env = join(this.root, ".env");
    writeFileSync(env, `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`);
    chmodSync(env, 0o600);
    mkdirSync(this.sandbox);
    if (options.apiBase !== undefined) this.#pointAt(options.apiBase);
  }

  #pointAt(apiBase: string): void {
    const client = join(this.root, "src/shared/telegram/client.ts");
    const real = 'const BOT_API = "https://api.telegram.org";';
    const text = readFileSync(client, "utf8");
    // Should the line change, fail here rather than send the test's requests to Telegram.
    if (!text.includes(real)) throw new Error(`${client} no longer has: ${real}`);
    writeFileSync(client, text.replace(real, `const BOT_API = ${JSON.stringify(apiBase)};`));
  }

  /** The command that runs the copy's src/<entry>/main.ts with our flags, as hooks and ctl run. */
  command(entry: "hooks" | "ctl" | "broker", args: readonly string[] = []): string[] {
    const config = `--config=${join(this.root, "bunfig.toml")}`;
    return [
      process.execPath,
      "--no-env-file",
      config,
      join(this.root, "src", entry, "main.ts"),
      ...args,
    ];
  }

  run(entry: "hooks" | "ctl", args: readonly string[], options: RunOptions = {}): Run {
    const result = Bun.spawnSync(this.command(entry, args), {
      cwd: options.cwd ?? this.root,
      env: { ...BASE_ENV, ...options.env },
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const { exitCode, stdout, stderr } = result;
    return { exitCode: exitCode ?? -1, stdout: stdout.toString(), stderr: stderr.toString() };
  }

  /** A hook event from a session that started in `projectDir`, as Claude Code runs it (F10, F15). */
  hook(event: string, projectDir: string, env: Readonly<Record<string, string>> = {}) {
    this.#sessions += 1;
    const session = `test-session-${this.#sessions}`;
    const stdin = JSON.stringify({ session_id: session, hook_event_name: event, cwd: projectDir });
    const sessionEnv = { CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CODE_ENTRYPOINT: "cli", ...env };
    return { ...this.run("hooks", [event], { cwd: projectDir, stdin, env: sessionEnv }), session };
  }

  ctl(...args: string[]): Run {
    return this.run("ctl", args);
  }

  health(): Promise<BrokerHealth | undefined> {
    return brokerHealth(this.state, noLog);
  }

  /**
   * The pids of the copy's broker processes, found by their command line; not the launcher's, which
   * names the broker's entry file too, for the moment it runs (plan 7.6).
   */
  brokerPids(): number[] {
    const pgrep = Bun.spawnSync(["/usr/bin/pgrep", "-f", this.brokerMain], { stderr: "ignore" });
    const pids = pgrep.stdout.toString().split("\n").filter(Boolean).map(Number);
    return pids.filter((pid) => {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)], {
        stderr: "ignore",
      });
      return !ps.stdout.toString().includes(this.brokerLauncher);
    });
  }

  /** The events in one of the copy's logs (broker, hooks or ctl). */
  logged(name: "broker" | "hooks" | "ctl"): Fields[] {
    const file = join(this.state.logs, `${name}.log`);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.map((line) => asFields(JSON.parse(line)) ?? {});
  }

  /** Kills the copy's brokers and deletes the copy. */
  remove(): void {
    for (const pid of this.brokerPids()) process.kill(pid, "SIGKILL");
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Waits up to `ms` for process `pid` to be gone. */
export async function gone(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!Bun.spawnSync(["/bin/ps", "-p", String(pid)], { stdout: "ignore" }).success) return true;
    await Bun.sleep(50);
  }
  return false;
}
