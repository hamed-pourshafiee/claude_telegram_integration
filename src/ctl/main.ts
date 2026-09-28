// ctl, the bridge's command line. Run it from the repo: bun run ctl <command>.
import { join } from "node:path";
import { BROKER_LAUNCH } from "../shared/broker-client.ts";
import { fileLog } from "../shared/file-log.ts";
import { CONFIG_FILE, ENV_FILE, HOME_DIR, REPO_ROOT, STATE } from "../shared/paths.ts";
import { ensureStateDir } from "../shared/state.ts";
import {
  brokerStatus,
  disableBridge,
  enableBridge,
  type Outcome,
  startBroker,
  stopBroker,
} from "./broker.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import { pairBot } from "./pair.ts";
import { installHooks, uninstallHooks } from "./setup.ts";

process.on("unhandledRejection", (reason) => {
  console.error("ctl: unhandled promise rejection:", reason);
  process.exit(1);
});

const USAGE =
  "Usage: bun run ctl doctor | start | stop | status | disable | enable | pair\n" +
  "       bun run ctl install [--dry-run] | uninstall [--dry-run]";

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  const dryRun = rest.length === 1 && rest[0] === "--dry-run";
  const takesDryRun = command === "install" || command === "uninstall";
  if (rest.length > 0 && !(dryRun && takesDryRun)) return usage();
  if (command === "doctor") return doctor();
  ensureStateDir(STATE);
  const log = fileLog(join(STATE.logs, "ctl.log"), "ctl");
  const hooks = {
    settingsFile: join(HOME_DIR, ".claude", "settings.json"),
    backupDir: join(STATE.dir, "backups"),
    bun: process.execPath,
    repoRoot: REPO_ROOT,
  };
  const commands: Record<string, () => Outcome | Promise<Outcome>> = {
    start: () => startBroker(STATE, BROKER_LAUNCH, log),
    stop: () => stopBroker(STATE, BROKER_LAUNCH, log),
    status: () => brokerStatus(STATE, ENV_FILE, log),
    disable: () => disableBridge(STATE, BROKER_LAUNCH, log),
    enable: () => enableBridge(STATE),
    pair: () => pairBot(STATE, BROKER_LAUNCH, log),
    install: () => installHooks(hooks, dryRun, log),
    uninstall: () => uninstallHooks(hooks, dryRun, log),
  };
  const run = command === undefined ? undefined : commands[command];
  if (run === undefined) return usage();
  const outcome = await run();
  console.log(outcome.text);
  return outcome.ok ? 0 : 1;
}

async function doctor(): Promise<number> {
  const paths = { envFile: ENV_FILE, configFile: CONFIG_FILE, repoRoot: REPO_ROOT, home: HOME_DIR };
  const checks = await runDoctor(paths);
  console.log(formatChecks(checks));
  return checks.every((check) => check.ok) ? 0 : 1;
}

function usage(): number {
  console.error(USAGE);
  return 2;
}

process.exitCode = await main(Bun.argv.slice(2));
