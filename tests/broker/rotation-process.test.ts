import { afterAll, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_LOG_BYTES } from "../../src/shared/log-rotation.ts";
import { ensureStateDir } from "../../src/shared/state.ts";
import { RepoCopy } from "../helpers/repo-copy.ts";

// Plan 6.1 with a real broker, in a throwaway copy of the repo (unpaired): it rotates the logs as it
// starts, and every hour after.
const copy = new RepoCopy();
afterAll(() => copy.remove());

test("a broker rotates a log past 5 MB as it starts, and says so in its own log", () => {
  ensureStateDir(copy.state);
  const hooksLog = join(copy.state.logs, "hooks.log");
  writeFileSync(hooksLog, "x".repeat(MAX_LOG_BYTES + 1), { mode: 0o600 });
  expect(copy.ctl("start").stdout).toMatch(/^started \(pid \d+\)/);
  expect(statSync(`${hooksLog}.1`).size).toBe(MAX_LOG_BYTES + 1);
  expect(existsSync(hooksLog)).toBe(false);
  const logged = copy.logged("broker");
  expect(logged).toContainEqual(
    expect.objectContaining({ event: "logs.rotated", files: "hooks.log" }),
  );
  // It rotates before it reports itself started.
  const events = logged.map((entry) => entry.event);
  expect(events.indexOf("logs.rotated")).toBeLessThan(events.indexOf("broker.started"));
});
