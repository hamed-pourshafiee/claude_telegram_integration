import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIdleSeconds, parseScreenLocked, readPresence } from "../../src/broker/ioreg.ts";
import { stateOf } from "../../src/broker/presence.ts";
import { DEFAULTS } from "../../src/shared/config.ts";

// Plan 2.6: the parsers, on ioreg output recorded on this Mac (macOS 27.0, 26A428) on 2026-09-28.
// fixtures/ioreg/IOHIDSystem.txt is `ioreg -r -c IOHIDSystem -d 1` as it came; Root-*.txt are
// `ioreg -n Root -d 1`, with the login and full name replaced by "user" and "User", and
// IOKitDiagnostics (93 KB of kernel allocation counters) shortened to {}. Root-locked.txt was
// recorded when the Mac locked itself after 30 minutes without input.
const FIXTURES = join(import.meta.dir, "..", "fixtures", "ioreg");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const HID = fixture("IOHIDSystem.txt");
const UNLOCKED = fixture("Root-unlocked.txt");
const LOCKED = fixture("Root-locked.txt");
const RECORDED = '"HIDIdleTime" = 155578961500';

/** The recorded IOHIDSystem output with another HIDIdleTime line. */
function withIdleLine(line: string): string {
  if (!HID.includes(RECORDED)) throw new Error("the fixture's HIDIdleTime line changed");
  return HID.replace(RECORDED, line);
}
const withIdle = (value: string) => withIdleLine(`"HIDIdleTime" = ${value}`);
const stateAt = (nanoseconds: string) =>
  stateOf(
    { idleSeconds: parseIdleSeconds(withIdle(nanoseconds)), locked: false },
    DEFAULTS.presence,
  ).state;

describe("the idle time, in nanoseconds (F12)", () => {
  test("the recorded value is read as seconds", () => {
    expect(parseIdleSeconds(HID)).toBe(155.578);
  });

  test.each([
    ["0", "active"],
    ["29000000000", "active"],
    ["29999999999", "active"],
    ["30000000000", "between"],
    ["179000000000", "between"],
    ["179999999999", "between"],
    ["180000000000", "away"],
  ] as const)("HIDIdleTime %s ns: %s", (nanoseconds, state) => {
    expect(stateAt(nanoseconds)).toBe(state);
  });

  test("missing or unreadable: unknown, which counts as at the Mac", () => {
    const without = HID.replace(/^.*"HIDIdleTime".*\n/m, "");
    expect(without).not.toContain("HIDIdleTime");
    for (const text of [without, "", withIdle("<0123abcd>"), withIdle("-5"), withIdle("")]) {
      expect(parseIdleSeconds(text)).toBeUndefined();
    }
    const unknown = { idleSeconds: undefined, locked: false };
    expect(stateOf(unknown, DEFAULTS.presence)).toEqual({ state: "active", because: "unknown" });
  });

  test("a HIDIdleTime nested in another value isn't the object's; of two objects, the smaller", () => {
    expect(parseIdleSeconds(withIdleLine('"Other" = {"HIDIdleTime"=1}'))).toBeUndefined();
    expect(parseIdleSeconds(withIdle("200000000000") + withIdle("5000000000"))).toBe(5);
  });
});

describe("the screen lock", () => {
  const lockedFlag = UNLOCKED.replace('"IOConsoleLocked" = No', '"IOConsoleLocked" = Yes');
  const lockedSession = UNLOCKED.replace(
    '"kCGSSessionOnConsoleKey"=Yes,',
    '"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes,',
  );

  test("the recorded roots: unlocked, and locked (both signals set)", () => {
    expect(parseScreenLocked(UNLOCKED)).toBe(false);
    expect(LOCKED).toContain('"IOConsoleLocked" = Yes');
    expect(LOCKED).toContain('"CGSSessionScreenIsLocked"=Yes');
    expect(parseScreenLocked(LOCKED)).toBe(true);
  });

  test("IOConsoleLocked = Yes, or the console session's CGSSessionScreenIsLocked: locked", () => {
    expect(lockedFlag).not.toBe(UNLOCKED);
    expect(lockedSession).not.toBe(UNLOCKED);
    expect(parseScreenLocked(lockedFlag)).toBe(true);
    expect(parseScreenLocked(lockedSession)).toBe(true);
  });

  test("a locked session that isn't on the console doesn't count", () => {
    const elsewhere = lockedSession.replace(
      '"kCGSSessionOnConsoleKey"=Yes',
      '"kCGSSessionOnConsoleKey"=No',
    );
    expect(parseScreenLocked(elsewhere)).toBe(false);
  });

  test("neither in the output: unknown", () => {
    expect(parseScreenLocked("")).toBeUndefined();
    expect(parseScreenLocked(HID)).toBeUndefined();
  });
});

describe("reading ioreg", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-ioreg-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** A stand-in for ioreg: a shell script. */
  const standIn = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // macOS checks a new executable the first time it runs: 0.3 to 0.7 s here, and more under load,
  // which /usr/sbin/ioreg never pays. So the stand-ins get more time than the real one's 2 s.
  const read = (ioreg: string) => readPresence({ ioreg, timeoutMs: 10_000 });

  test("the recordings, through the same path as the real ioreg", async () => {
    const recorded = (root: string) => {
      const hid = join(FIXTURES, "IOHIDSystem.txt");
      const other = join(FIXTURES, root);
      return standIn(root, `case "$1" in -r) cat '${hid}';; *) cat '${other}';; esac`);
    };
    const unlocked = await read(recorded("Root-unlocked.txt"));
    expect(unlocked).toEqual({ idleSeconds: 155.578, locked: false, problems: [] });
    const locked = await read(recorded("Root-locked.txt"));
    expect(locked).toEqual({ idleSeconds: 155.578, locked: true, problems: [] });
    expect(stateOf(locked, DEFAULTS.presence)).toEqual({ state: "away", because: "locked" });
  });

  test("ioreg failing, empty, missing or too slow: unknown, with the reasons", async () => {
    const failing = await read(standIn("failing", "exit 3"));
    expect(failing).toEqual({
      idleSeconds: undefined,
      locked: undefined,
      problems: ["idle time: ioreg exited with 3", "screen lock: ioreg exited with 3"],
    });
    const empty = await read(standIn("empty", "true"));
    expect(empty.problems).toEqual([
      "idle time: not in ioreg's output",
      "screen lock: not in ioreg's output",
    ]);
    const missing = await read(join(dir, "no-such-ioreg"));
    expect(missing.problems[0]).toStartWith("idle time: ioreg didn't run");
    const started = Date.now();
    const slow = await readPresence({ ioreg: standIn("slow", "exec sleep 5"), timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.idleSeconds).toBeUndefined();
    expect(slow.problems[0]).toBe("idle time: ioreg was stopped by SIGKILL (limit 200 ms)");
  });

  test("the real ioreg on this Mac gives both", async () => {
    const reading = await readPresence();
    expect(reading.problems).toEqual([]);
    expect(reading.idleSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof reading.locked).toBe("boolean");
  });
});
