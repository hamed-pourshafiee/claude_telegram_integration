import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { Waiters } from "../../src/broker/waiters.ts";

// Plan 3.1: the waiters' states in SQLite. Handing over and cancelling race on one row (flow 2).
const dir = mkdtempSync(join(tmpdir(), "tg-waiters-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
let clock: number;
let sessions: Sessions;
let waiters: Waiters;
beforeEach(() => {
  files += 1;
  clock = 1_000_000;
  const db = BrokerDb.open(join(dir, `waiters-${files}.db`));
  sessions = new Sessions(db, () => new Date(clock));
  waiters = new Waiters(db, () => clock);
});

const ID = "b1e81638";
const pids = { pid: 4001, claudePid: 4000 };
/** A stop in session ID, and its waiter registered: the waiter's ref. */
function stopAndWait() {
  sessions.touch({ id: ID, projectDir: "/work/sandbox", entrypoint: "cli" });
  const generation = sessions.stop(ID);
  clock += 10;
  const waiter = waiters.register({ sessionId: ID, generation, ...pids });
  if (waiter === "stale") throw new Error("stale at once");
  return { sessionId: ID, generation };
}

describe("registering", () => {
  test("in the current generation: waiting; again (a reconnect): the same waiter", () => {
    const ref = stopAndWait();
    expect(waiters.get(ref)).toMatchObject({ state: "waiting", ...pids });
    expect(waiters.register({ ...ref, pid: 1, claudePid: 1 })).toMatchObject({ pid: pids.pid });
    expect(waiters.listening()).toHaveLength(1);
  });

  test("an older generation, or an ended session: stale", () => {
    const ref = stopAndWait();
    sessions.advance(ID);
    expect(waiters.register({ ...ref, generation: ref.generation + 1, ...pids })).not.toBe("stale");
    expect(waiters.register({ sessionId: ID, generation: 0, ...pids })).toBe("stale");
    sessions.end(ID);
    const next = sessions.get(ID)?.generation ?? 0;
    expect(waiters.register({ sessionId: ID, generation: next, ...pids })).toBe("stale");
    expect(waiters.register({ sessionId: "unknown", generation: 1, ...pids })).toBe("stale");
  });
});

describe("a reply and typing at the Mac race (flow 2)", () => {
  test("reply first: handed; the cancel then finds it crossed, and it keeps the reply", () => {
    const ref = stopAndWait();
    expect(waiters.handOver(ref, 77)).toBe(true);
    const { cancelled, crossed } = waiters.cancel(ID, clock);
    expect(cancelled).toEqual([]);
    expect(crossed.map((waiter) => waiter.updateId)).toEqual([77]);
    expect(waiters.confirm(ref, 77)).toBe(true);
    expect(waiters.get(ref)?.state).toBe("delivered");
  });

  test("typed first: cancelled; the reply then finds nobody waiting", () => {
    const ref = stopAndWait();
    expect(waiters.cancel(ID, clock).cancelled).toHaveLength(1);
    expect(waiters.handOver(ref, 77)).toBe(false);
    expect(waiters.get(ref)?.state).toBe("cancelled");
    expect(waiters.listening()).toEqual([]);
  });

  test("a late cancel, from before a newer waiter registered, leaves that waiter waiting", () => {
    const typedAt = clock;
    clock += 1000;
    const ref = stopAndWait();
    expect(waiters.cancel(ID, typedAt)).toEqual({ cancelled: [], crossed: [] });
    expect(waiters.get(ref)?.state).toBe("waiting");
  });
});

describe("ending", () => {
  test("a newer stop supersedes the older waiter; the newer one keeps listening", () => {
    const old = stopAndWait();
    const current = stopAndWait();
    expect(waiters.supersede(ID, current.generation).map((waiter) => waiter.generation)).toEqual([
      old.generation,
    ]);
    // The old hook's own end, after its replacement registered, changes nothing for the new one.
    expect(waiters.end(old)).toBe("ended");
    expect(waiters.listening().map((waiter) => waiter.generation)).toEqual([current.generation]);
  });

  test("end reports what it was: waiting, or handed (a reply never confirmed)", () => {
    const first = stopAndWait();
    expect(waiters.end(first)).toBe("waiting");
    const second = stopAndWait();
    waiters.handOver(second, 5);
    expect(waiters.end(second)).toBe("handed");
    expect(waiters.get(second)?.state).toBe("ended");
    expect(waiters.open()).toEqual([]);
  });

  test("confirm: once handed and only for its reply; again after a reconnect, still yes", () => {
    const ref = stopAndWait();
    expect(waiters.confirm(ref, 5)).toBe(false);
    waiters.handOver(ref, 5);
    expect(waiters.confirm(ref, 6)).toBe(false);
    expect(waiters.confirm(ref, 5)).toBe(true);
    expect(waiters.confirm(ref, 5)).toBe(true);
    expect(waiters.end(ref)).toBe("delivered");
  });
});
