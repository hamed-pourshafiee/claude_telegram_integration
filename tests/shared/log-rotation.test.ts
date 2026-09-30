import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLog } from "../../src/shared/file-log.ts";
import { KEEP_LOGS, MAX_LOG_BYTES, rotateLogs } from "../../src/shared/log-rotation.ts";

// Plan 6.1: the broker rotates the logs, so .state/logs/ stays bounded.
const root = mkdtempSync(join(tmpdir(), "tg-rotate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;

/** A logs folder holding `files`, each 0600. */
function logs(files: Readonly<Record<string, string>>): string {
  count += 1;
  const dir = join(root, `logs-${count}`);
  mkdirSync(dir, { mode: 0o700 });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, { mode: 0o600 });
  }
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

test("a log past the limit becomes .1, still private, and the next line starts a new one", () => {
  const dir = logs({
    "broker.log": "x".repeat(101),
    "hooks.log": "y".repeat(100),
    "a.txt": "z".repeat(500),
  });
  expect(rotateLogs(dir, 100)).toEqual(["broker.log"]);
  expect(read(dir, "broker.log.1")).toBe("x".repeat(101));
  expect(statSync(join(dir, "broker.log.1")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, "broker.log"))).toBe(false);
  fileLog(join(dir, "broker.log"), "broker")("broker.started", { schema: 4 });
  expect(JSON.parse(read(dir, "broker.log"))).toMatchObject({ event: "broker.started" });
  expect(statSync(join(dir, "broker.log")).mode & 0o777).toBe(0o600);
  // At the limit but not past it, and anything but a log: left as they were.
  expect(readdirSync(dir).sort()).toEqual(["a.txt", "broker.log", "broker.log.1", "hooks.log"]);
});

test(`older copies move up one, and only ${KEEP_LOGS} are kept`, () => {
  const dir = logs({
    "audit.log": "4",
    "audit.log.1": "3",
    "audit.log.2": "2",
    "audit.log.3": "1",
  });
  expect(rotateLogs(dir, 0)).toEqual(["audit.log"]);
  const copies = ["audit.log.1", "audit.log.2", "audit.log.3"];
  expect(copies.map((name) => read(dir, name))).toEqual(["4", "3", "2"]);
  expect(readdirSync(dir).sort()).toEqual(copies);
});

test("by default a log is rotated past 5 MB", () => {
  expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
  const dir = logs({
    "broker.log": "x".repeat(MAX_LOG_BYTES),
    "hooks.log": "y".repeat(MAX_LOG_BYTES + 1),
  });
  expect(rotateLogs(dir)).toEqual(["hooks.log"]);
});
