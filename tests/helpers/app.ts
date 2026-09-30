import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppDeps, createApp } from "../../src/broker/app.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import type { Reading } from "../../src/broker/ioreg.ts";
import { parseConfig } from "../../src/shared/config.ts";
import { noLog } from "../../src/shared/log.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { Secret } from "../../src/shared/secret.ts";
import { FakeTelegram, ok } from "./fake-telegram.ts";
import { FAKE_TOKEN } from "./secrets.ts";
import { until } from "./wait.ts";

/** The paired user, in the bot chat. */
export const YOU = { id: 4242, is_bot: false, first_name: "Hamed", username: "hamed" };

export interface AppHarness {
  readonly fake: FakeTelegram;
  readonly dir: string;
  /** What the stand-in Mac shows; each test starts at the Mac. */
  mac: Reading;
  /** The broker's parts on a new database, or on `db`; /new starts `launchSession`, if given. */
  readonly app: (
    db?: BrokerDb,
    extra?: Pick<AppDeps, "launchSession">,
  ) => App & { readonly db: BrokerDb };
}

/**
 * The broker's parts together, in this process, against a fake Bot API and a stand-in Mac: a new
 * database for each app, and a fresh fake for each test.
 */
export function appHarness(name: string): AppHarness {
  const fake = new FakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), `tg-${name}-`));
  let controller = new AbortController();
  let files = 0;
  const apps: App[] = [];
  const harness: AppHarness = {
    fake,
    dir,
    mac: { idleSeconds: 1, locked: false, problems: [] },
    app: (db, extra = {}) => {
      files += 1;
      const opened = db ?? BrokerDb.open(join(dir, `app-${files}.db`));
      const deps = {
        token: new Secret(FAKE_TOKEN),
        db: opened,
        log: noLog,
        signal: controller.signal,
      };
      const config = parseConfig({}, { repoRoot: dir, home: dir });
      const readPresence = () => Promise.resolve(harness.mac);
      const paths = statePaths(join(dir, `state-${files}`));
      const parts = createApp({
        ...deps,
        ...extra,
        config,
        paths,
        readPresence,
        apiBase: fake.url,
      });
      apps.push(parts);
      return { db: opened, ...parts };
    },
  };
  afterAll(() => {
    controller.abort();
    fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    controller.abort();
    // A poller may have sent a getUpdates the fake hasn't read yet. It takes its answer now, not one
    // this test queues: Telegram would send that update again, the fake can't.
    await until(() => apps.every((app) => !app.poller.running));
    await Bun.sleep(10);
    controller = new AbortController();
    harness.mac = { idleSeconds: 1, locked: false, problems: [] };
    fake.reset();
    // Like long polling: an empty answer after a short wait.
    fake.fallback("getUpdates", { json: { ok: true, result: [] }, delayMs: 30 });
    fake.fallback("setMyCommands", ok(true));
  });
  return harness;
}
