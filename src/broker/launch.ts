// Starts the broker and exits at once, so launchd adopts it (D3, plan 7.6). Claude Code kills a hook's
// whole process tree when it stops the hook, found by parent pid (F22): a broker that was still the
// hook's child would go with it.
//   bun --no-env-file --config=<repo>/bunfig.toml <repo>/src/broker/launch.ts <the broker's command…>
// spawnBroker() gives it the broker's environment, working folder and stderr, which the broker keeps.
import { messageOf } from "../shared/errors.ts";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`broker launcher: ${messageOf(reason)}\n`);
  process.exit(1);
});

const command = Bun.argv.slice(2);
if (command.length === 0) {
  process.stderr.write("broker launcher: no command\n");
  process.exit(1);
}
try {
  const broker = Bun.spawn({
    cmd: command,
    env: process.env,
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  broker.unref();
} catch (error) {
  process.stderr.write(`broker launcher: ${messageOf(error)}\n`);
  process.exit(1);
}
process.exit(0);
