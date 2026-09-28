import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { brokerEnv } from "../../src/shared/broker-client.ts";
import { fileLog } from "../../src/shared/file-log.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { ensureStateDir, isDisabled, setDisabled } from "../../src/shared/state.ts";

const root = mkdtempSync(join(tmpdir(), "tg-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const mode = (path: string) => statSync(path).mode & 0o777;

describe(".state/", () => {
  test("is created 0700, and a looser one is tightened (design §5)", () => {
    const paths = statePaths(join(root, "repo"));
    mkdirSync(paths.dir, { recursive: true, mode: 0o755 });
    chmodSync(paths.dir, 0o755);
    ensureStateDir(paths);
    expect(mode(paths.dir)).toBe(0o700);
    expect(mode(paths.logs)).toBe(0o700);
  });

  test("the disabled flag is a file that persists until cleared (D3)", () => {
    const paths = statePaths(join(root, "flag"));
    expect(isDisabled(paths)).toBe(false);
    setDisabled(paths, true);
    expect(isDisabled(paths)).toBe(true);
    expect(mode(paths.disabled)).toBe(0o600);
    setDisabled(paths, false);
    expect(isDisabled(paths)).toBe(false);
    setDisabled(paths, false);
    expect(isDisabled(paths)).toBe(false);
  });
});

test("the broker's environment holds only PATH, HOME, USER and LOGNAME, from the user database", () => {
  const env = brokerEnv();
  expect(Object.keys(env).sort()).toEqual(["HOME", "LOGNAME", "PATH", "USER"]);
  expect(env.HOME).toBe(userInfo().homedir);
  expect(env.USER).toBe(userInfo().username);
  expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
});

describe("fileLog", () => {
  test("appends one JSON line per event to a 0600 file", () => {
    const file = join(root, "events.log");
    const log = fileLog(file, "test");
    log("first", { n: 1 });
    log("second", { ok: true });
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toMatchObject([
      { source: "test", pid: process.pid, event: "first", n: 1 },
      { source: "test", event: "second", ok: true },
    ]);
    expect(mode(file)).toBe(0o600);
  });

  test("a field can't overwrite the line's own names (the type forbids it too)", () => {
    const file = join(root, "reserved.log");
    const fields = JSON.parse('{"event": "Stop", "pid": 1, "n": 2}') as { n: number };
    fileLog(file, "test")("hook.event", fields);
    const line = JSON.parse(readFileSync(file, "utf8"));
    expect(line).toMatchObject({ event: "hook.event", pid: process.pid, n: 2 });
  });

  test("a log it can't write is reported once on stderr, and never throws", () => {
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const log = fileLog(join(root, "no-such-folder", "x.log"), "test");
      log("one", {});
      log("two", {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("test: cannot write");
    } finally {
      spy.mockRestore();
    }
  });
});
