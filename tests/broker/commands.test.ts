import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duration, parseCommand, runCommand } from "../../src/broker/commands.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import type { Reading } from "../../src/broker/ioreg.ts";
import { Presence } from "../../src/broker/presence.ts";
import { DEFAULTS } from "../../src/shared/config.ts";
import { noLog } from "../../src/shared/log.ts";

// Plan 2.6: /away /auto /off /status, and what /status says.
const dir = mkdtempSync(join(tmpdir(), "tg-commands-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

/** A Presence that has had one look at a Mac showing `reading`. */
async function lookedAt(reading: Omit<Reading, "problems">): Promise<Presence> {
  files += 1;
  const presence = new Presence({
    db: BrokerDb.open(join(dir, `commands-${files}.db`)),
    log: noLog,
    limits: DEFAULTS.presence,
    signal: new AbortController().signal,
    read: () => Promise.resolve({ ...reading, problems: [] }),
  });
  await presence.sample();
  return presence;
}

describe("which texts are commands", () => {
  test.each([
    ["/status", "status"],
    ["/away", "away"],
    ["/auto", "auto"],
    ["/off", "off"],
    ["/local", "local"],
    ["/status@SomeBot", "status"],
    ["  /AWAY \n", "away"],
  ] as const)("%j: %s", (text, name) => {
    expect(parseCommand(text)).toBe(name);
  });

  test.each([["/status now"], ["/stat"], ["status"], ["/pair ABCD-EFGH"], ["/start"], [""]])(
    "%j: none",
    (text) => {
      expect(parseCommand(text)).toBeUndefined();
    },
  );
});

describe("/status", () => {
  test("the idle time unknown: at the Mac, and it says 'unknown'", async () => {
    const text = runCommand("status", await lookedAt({ idleSeconds: undefined, locked: false }));
    expect(text).toStartWith("🟢 At the Mac: the idle time is unknown");
    expect(text).toContain("Idle: unknown · Screen: unlocked");
  });

  test("the screen locked: away", async () => {
    const text = runCommand("status", await lookedAt({ idleSeconds: 12.5, locked: true }));
    expect(text.split("\n")).toEqual([
      "🔴 Away: the screen is locked",
      "Idle: 12 s · Screen: locked",
      "Mode: auto. Away means the screen is locked or 3 min without input.",
    ]);
  });

  test("in between, and away after 3 minutes without input", async () => {
    const between = runCommand("status", await lookedAt({ idleSeconds: 45, locked: false }));
    expect(between).toStartWith("🟡 In between: no input for 45 s");
    const away = runCommand("status", await lookedAt({ idleSeconds: 185, locked: undefined }));
    expect(away).toStartWith("🔴 Away: no input for 3 min 5 s\nIdle: 3 min 5 s · Screen: unknown");
  });
});

describe("/away, /off and /auto", () => {
  test("each sets the mode, which /status then shows", async () => {
    const presence = await lookedAt({ idleSeconds: 2, locked: false });
    expect(runCommand("away", presence)).toStartWith("🔴 Away mode");
    expect(presence.mode).toBe("away");
    expect(runCommand("status", presence)).toStartWith("🔴 Away: you sent /away\n");
    expect(runCommand("off", presence)).toStartWith("🔕 Off");
    expect(presence.mode).toBe("off");
    expect(runCommand("status", presence)).toEndWith(
      "Mode: off (/off). Nothing comes here until /auto or /away.",
    );
    const auto = runCommand("auto", presence);
    expect(presence.mode).toBe("auto");
    expect(auto).toEndWith("\nNow: 🟢 At the Mac: last input 2 s ago");
  });
});

test.each([
  [0, "0 s"],
  [59.9, "59 s"],
  [60, "1 min"],
  [185, "3 min 5 s"],
  [3600, "1 h"],
  [7830, "2 h 10 min"],
])("duration(%d) is %s", (seconds, text) => {
  expect(duration(seconds)).toBe(text);
});
