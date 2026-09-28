// ctl, the bridge's command line. Run it from the repo: bun run ctl <command>.
// Commands so far: doctor. Later steps add start, stop, status, pair, install and uninstall.
import { homedir } from "node:os";
import { CONFIG_FILE, ENV_FILE, REPO_ROOT } from "../shared/paths.ts";
import { formatChecks, runDoctor } from "./doctor.ts";

process.on("unhandledRejection", (reason) => {
  console.error("ctl: unhandled promise rejection:", reason);
  process.exit(1);
});

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === "doctor") {
    const paths = {
      envFile: ENV_FILE,
      configFile: CONFIG_FILE,
      repoRoot: REPO_ROOT,
      home: homedir(),
    };
    const checks = await runDoctor(paths);
    console.log(formatChecks(checks));
    return checks.every((check) => check.ok) ? 0 : 1;
  }
  console.error("Usage: bun run ctl doctor");
  return 2;
}

process.exitCode = await main(Bun.argv.slice(2));
