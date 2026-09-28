// ctl, the bridge's command line. Run it from the repo: bun run ctl <command>.
// Later steps add pair, install and uninstall.
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

process.on("unhandledRejection", (reason) => {
  console.error("ctl: unhandled promise rejection:", reason);
  process.exit(1);
});

const USAGE = "Usage: bun run ctl doctor | start | stop | status | disable | enable";

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (rest.length > 0) return usage();
  if (command === "doctor") return doctor();
  ensureStateDir(STATE);
  const log = fileLog(join(STATE.logs, "ctl.log"), "ctl");
  const commands: Record<string, () => Outcome | Promise<Outcome>> = {
    start: () => startBroker(STATE, BROKER_LAUNCH, log),
    stop: () => stopBroker(STATE, BROKER_LAUNCH, log),
    status: () => brokerStatus(STATE, ENV_FILE, log),
    disable: () => disableBridge(STATE, BROKER_LAUNCH, log),
    enable: () => enableBridge(STATE),
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
