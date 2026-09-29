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
  refuseVerboseFetch(process.env);
  const config = loadConfig(CONFIG_FILE, { repoRoot: REPO_ROOT, home: HOME_DIR });
  const token = loadBotToken(ENV_FILE);
  const db = BrokerDb.open(STATE.db);
  const shutdown = new AbortController();
  const { routes, relay } = createApp({
    token,
    db,
    log,
    config,
    paths: STATE,
    signal: shutdown.signal,
  });
  const server = startServer(STATE.socket, routes);
  writeFileSync(STATE.pid, `${process.pid}\n`);
  log("broker.started", { schema: db.schemaVersion });
  const stop = (reason: string) => {
    shutdown.abort();
    relay.close();
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
