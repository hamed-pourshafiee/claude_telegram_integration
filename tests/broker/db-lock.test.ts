import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb, SCHEMA_VERSION } from "../../src/broker/db.ts";
import { acquireLock } from "../../src/broker/lock.ts";
import { REPO_ROOT } from "../../src/shared/paths.ts";

const dir = mkdtempSync(join(tmpdir(), "tg-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BrokerDb", () => {
  test("a new database is migrated to the current schema, in WAL mode", () => {
    const db = BrokerDb.open(join(dir, "new.db"));
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    db.close();
    const raw = new Database(join(dir, "new.db"));
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
  });

  test("meta values are kept, overwritten and still there after reopening", () => {
    const file = join(dir, "meta.db");
    const db = BrokerDb.open(file);
    expect(db.getMeta("offset")).toBeUndefined();
    db.setMeta("offset", "100");
    db.setMeta("offset", "101");
    db.close();
    const again = BrokerDb.open(file);
    expect(again.getMeta("offset")).toBe("101");
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    again.close();
  });

  test("a database from a newer version of this code is refused", () => {
    const file = join(dir, "newer.db");
    const raw = new Database(file, { create: true });
    raw.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => BrokerDb.open(file)).toThrow("newer than this code's");
  });
});

const LOCK_MODULE = JSON.stringify(join(REPO_ROOT, "src/broker/lock.ts"));

/** Starts a process that takes the lock on `file` and holds it; resolves once it holds it. */
function holder(file: string) {
  return lockProcess(`import { acquireLock } from ${LOCK_MODULE};
    const held = acquireLock(${JSON.stringify(file)});
    console.log(held ? "held" : "busy");
    await Bun.sleep(60_000);`);
}

/** Starts a process that waits for the clock to reach `start`, then tries to take the lock. */
function racer(file: string, start: number) {
  return lockProcess(`import { acquireLock } from ${LOCK_MODULE};
    while (Date.now() < ${start});
    const held = acquireLock(${JSON.stringify(file)});
    console.log(held ? "held" : "busy");
    await Bun.sleep(60_000);`);
}

/** Runs `code` in a new Bun process; resolves with what it printed first. */
async function lockProcess(code: string) {
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  return { child, said: new TextDecoder().decode(first.value).trim() };
}

describe("the single-instance lock", () => {
  test("another process can't take it while it is held; after kill -9 it can at once", async () => {
    const file = join(dir, "broker.lock");
    const { child, said } = await holder(file);
    expect(said).toBe("held");
    expect(acquireLock(file)).toBeUndefined();
    child.kill("SIGKILL");
    await child.exited;
    const lock = acquireLock(file);
    expect(lock).toBeDefined();
    lock?.close();
  }, 20_000);

  test("processes racing for a free lock at the same moment: exactly one gets it", async () => {
    const start = Date.now() + 1500;
    const files = Array.from({ length: 8 }, (_, index) => join(dir, `race-${index}.lock`));
    const racers = await Promise.all(
      files.flatMap((file) => [racer(file, start), racer(file, start)]),
    );
    for (const { child } of racers) child.kill("SIGKILL");
    const pairs = files.map((_, index) => [racers[2 * index]?.said, racers[2 * index + 1]?.said]);
    expect(pairs.map((pair) => pair.sort().join(" and "))).toEqual(
      files.map(() => "busy and held"),
    );
  }, 20_000);

  test("while this process holds it, another process is refused", async () => {
    const file = join(dir, "held-here.lock");
    const lock = acquireLock(file);
    expect(lock).toBeDefined();
    const { child, said } = await holder(file);
    expect(said).toBe("busy");
    child.kill("SIGKILL");
    await child.exited;
    lock?.close();
  }, 20_000);
});
