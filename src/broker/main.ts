// The broker (design §3): one long-running process per Mac, started on demand by a hook or by
// `ctl start`, detached and with a minimal environment (D3):
//   bun --no-env-file --config=<repo>/bunfig.toml <repo>/src/broker/main.ts
import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../shared/config.ts";
import { loadBotToken } from "../shared/env.ts";
import { messageOf } from "../shared/errors.ts";
import { fileLog } from "../shared/file-log.ts";
import { rotateLogs } from "../shared/log-rotation.ts";
import { CONFIG_FILE, ENV_FILE, HOME_DIR, REPO_ROOT, STATE } from "../shared/paths.ts";
import { ensureStateDir, isDisabled } from "../shared/state.ts";
import { refuseVerboseFetch } from "../shared/telegram/errors.ts";
import { createApp } from "./app.ts";
import { BrokerDb } from "./db.ts";
import { acquireLock } from "./lock.ts";
import { startServer } from "./server.ts";

process.umask(0o077);
ensureStateDir(STATE);
const log = fileLog(join(STATE.logs, "broker.log"), "broker");
/** Every step of a permission prompt relayed to Telegram (D9). */
const audit = fileLog(join(STATE.logs, "audit.log"), "audit");
/** How often the logs are looked at for rotation, after the look at start. */
const ROTATE_MS = 60 * 60 * 1000;

process.on("unhandledRejection", (reason) => {
  log("broker.crash", { error: messageOf(reason) });
  process.exit(1);
});

/** Held for the broker's whole life: closing it, or losing the reference, releases the lock. */
let lock: Database | undefined;

function main(): void {
  if (isDisabled(STATE)) {
    log("broker.not-started", { reason: "disabled" });
    return;
  }
  lock = acquireLock(STATE.lock);
  if (!lock) {
    log("broker.not-started", { reason: "another broker holds the lock" });
    return;
  }
  // A broker spawned in a race waits up to 0.5 s for the lock, and gets it once the winner stops:
  // after `ctl uninstall` or `disable`, say, which set the flag in the meantime (plan 6.1).
  if (isDisabled(STATE)) {
    lock.close();
    log("broker.not-started", { reason: "disabled while it waited for the lock" });
    return;
  }
  refuseVerboseFetch(process.env);
  const config = loadConfig(CONFIG_FILE, { repoRoot: REPO_ROOT, home: HOME_DIR });
  const token = loadBotToken(ENV_FILE);
  const db = BrokerDb.open(STATE.db);
  const shutdown = new AbortController();
  const { routes, relay, asks } = createApp({
    token,
    db,
    log,
    audit,
    config,
    paths: STATE,
    signal: shutdown.signal,
  });
  const server = startServer(STATE.socket, routes);
  writeFileSync(STATE.pid, `${process.pid}\n`);
  rotate();
  setInterval(rotate, ROTATE_MS);
  log("broker.started", { schema: db.schemaVersion });
  const stop = (reason: string) => {
    shutdown.abort();
    relay.close();
    asks.close();
    void server.stop(true);
    db.close();
    rmSync(STATE.socket, { force: true });
    rmSync(STATE.pid, { force: true });
    lock?.close();
    log("broker.stopped", { reason });
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  watchDisabledFlag(() => stop("disabled"));
}

/** Rotates every log in .state/logs/ that has grown too big (plan 6.1); a failure is only logged. */
function rotate(): void {
  try {
    const files = rotateLogs(STATE.logs);
    if (files.length > 0) log("logs.rotated", { files: files.join(",") });
  } catch (error) {
    log("logs.rotate-failed", { error: messageOf(error) });
  }
}

/**
 * Stops the broker once the disabled flag is set. The first look comes now that the broker can be
 * found: `ctl disable` sets the flag before it looks for a broker, so either ctl finds this one or
 * this one sees the flag, even when both happen during startup. Then it looks every second, which
 * also covers a flag set by hand.
 */
function watchDisabledFlag(stop: () => void): void {
  if (isDisabled(STATE)) {
    stop();
    return;
  }
  setInterval(() => {
    if (isDisabled(STATE)) stop();
  }, 1000);
}

try {
  main();
} catch (error) {
  log("broker.failed", { error: messageOf(error) });
  process.exit(1);
}
