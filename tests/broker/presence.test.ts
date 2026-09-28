import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import type { Reading } from "../../src/broker/ioreg.ts";
import { Presence, type PresenceDeps, stateOf } from "../../src/broker/presence.ts";
import { DEFAULTS } from "../../src/shared/config.ts";
import { type LogFields, noLog } from "../../src/shared/log.ts";
import { until } from "../helpers/wait.ts";

// Plan 2.6: flow 3's states from the Mac's signals, the mode set from Telegram, and the 5 s looks.
const dir = mkdtempSync(join(tmpdir(), "tg-presence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
function openDb(): BrokerDb {
  files += 1;
  return BrokerDb.open(join(dir, `presence-${files}.db`));
}

const limits = DEFAULTS.presence;
const look = (idleSeconds: number | undefined, locked: boolean | undefined): Reading => ({
  idleSeconds,
  locked,
  problems: [],
});
const presenceOf = (deps: Partial<PresenceDeps> = {}) =>
  new Presence({ db: openDb(), log: noLog, limits, signal: new AbortController().signal, ...deps });

describe("flow 3's states (D4)", () => {
  test.each([
    ["last input 29.999 s ago", look(29.999, false), "active", "input"],
    ["idle 30 s", look(30, false), "between", "idle"],
    ["idle 179.999 s", look(179.999, false), "between", "idle"],
    ["idle 180 s", look(180, false), "away", "idle"],
    ["locked, with input 2 s ago", look(2, true), "away", "locked"],
    ["locked, idle time unknown", look(undefined, true), "away", "locked"],
    ["idle 200 s, lock unknown", look(200, undefined), "away", "idle"],
    ["idle time unknown", look(undefined, false), "active", "unknown"],
    ["nothing known", look(undefined, undefined), "active", "unknown"],
  ] as const)("%s: %s", (_, reading, state, because) => {
    expect(stateOf(reading, limits)).toEqual({ state, because });
  });

  test("the thresholds are config.json's", () => {
    expect(stateOf(look(10, false), { activeSeconds: 5, awaySeconds: 10 }).state).toBe("away");
  });
});

describe("the mode and the snapshot", () => {
  test("before the first look nothing is known, which counts as at the Mac", () => {
    const presence = presenceOf({ read: () => Promise.resolve(look(500, true)) });
    expect(presence.snapshot()).toEqual({
      mode: "auto",
      state: "active",
      because: "unknown",
      idleSeconds: undefined,
      locked: undefined,
    });
  });

  test("the mode is auto at first, then stored: a restarted broker keeps it", () => {
    const db = openDb();
    const first = presenceOf({ db });
    expect(first.mode).toBe("auto");
    first.setMode("away");
    expect(presenceOf({ db }).mode).toBe("away");
    first.setMode("off");
    expect(presenceOf({ db }).mode).toBe("off");
    first.setMode("auto");
    expect(presenceOf({ db }).mode).toBe("auto");
  });

  test("away mode is away whatever the Mac says; off keeps the Mac's state", async () => {
    const presence = presenceOf({ read: () => Promise.resolve(look(1, false)) });
    await presence.sample();
    expect(presence.snapshot()).toMatchObject({ mode: "auto", state: "active", because: "input" });
    presence.setMode("away");
    expect(presence.snapshot()).toEqual({
      mode: "away",
      state: "away",
      because: "away mode",
      idleSeconds: 1,
      locked: false,
    });
    presence.setMode("off");
    expect(presence.snapshot()).toMatchObject({ mode: "off", state: "active" });
  });
});

/** A Log that keeps what it is given. */
function recorder() {
  const events: { event: string; fields: LogFields }[] = [];
  return { events, log: (event: string, fields: LogFields) => events.push({ event, fields }) };
}

describe("looking at the Mac", () => {
  test("it looks every interval until stopped, and logs each change of state or reason once", async () => {
    const looks = [
      look(1, false),
      look(200, false),
      look(200, true),
      look(201, true),
      look(40, false),
    ];
    let calls = 0;
    const read = () => {
      calls += 1;
      return Promise.resolve(looks[Math.min(calls, looks.length) - 1] ?? look(0, false));
    };
    const { events, log } = recorder();
    const controller = new AbortController();
    const presence = presenceOf({ log, read, signal: controller.signal, intervalMs: 10 });
    presence.start();
    expect(await until(() => calls >= 7)).toBe(true);
    controller.abort();
    expect(await until(() => !presence.running)).toBe(true);
    const seen = calls;
    await Bun.sleep(50);
    expect(calls).toBe(seen);
    expect(events.map(({ event, fields }) => [event, fields.state, fields.because])).toEqual([
      ["presence.changed", "active", "input"],
      ["presence.changed", "away", "idle"],
      ["presence.changed", "away", "locked"],
      ["presence.changed", "between", "idle"],
    ]);
  });
});

describe("when the Mac can't be read", () => {
  test("a look that fails counts as at the Mac, logged once until it recovers", async () => {
    const answers: (() => Promise<Reading>)[] = [
      () => Promise.reject(new Error("no ioreg")),
      () => Promise.reject(new Error("no ioreg")),
      () => Promise.resolve({ ...look(undefined, false), problems: ["idle time: not there"] }),
      () => Promise.resolve(look(200, false)),
    ];
    const { events, log } = recorder();
    const fallback = () => Promise.resolve(look(0, false));
    const presence = presenceOf({ log, read: () => (answers.shift() ?? fallback)() });
    await presence.sample();
    expect(presence.snapshot()).toMatchObject({ state: "active", because: "unknown" });
    await presence.sample();
    await presence.sample();
    await presence.sample();
    expect(presence.snapshot()).toMatchObject({ state: "away", because: "idle" });
    expect(events.map(({ event, fields }) => [event, fields.problems ?? fields.state])).toEqual([
      ["presence.unreadable", "the look failed: no ioreg"],
      ["presence.changed", "active"],
      ["presence.unreadable", "idle time: not there"],
      ["presence.readable", undefined],
      ["presence.changed", "away"],
    ]);
  });
});
