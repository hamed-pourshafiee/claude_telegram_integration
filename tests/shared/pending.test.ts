import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePaths } from "../../src/shared/paths.ts";
import { readPending, removePending, writePending } from "../../src/shared/pending.ts";

// Plan 3.1: what hooks couldn't tell a broker waits in .state/pending/ for the next one.
const root = mkdtempSync(join(tmpdir(), "tg-pending-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const paths = statePaths(root);

test("written privately, read oldest first, removed once applied; a bad file is reported", () => {
  writePending(paths, { kind: "end", sessionId: "b1e8", generation: 3, at: 2000 });
  writePending(paths, { kind: "cancel", sessionId: "b1e8", at: 1000 });
  writeFileSync(join(paths.pending, "cancel-5-x.json"), "{not json");
  expect(statSync(paths.pending).mode & 0o777).toBe(0o700);
  const bad: string[] = [];
  const entries = readPending(paths, (file) => bad.push(file));
  expect(entries.map((entry) => entry.item)).toEqual([
    { kind: "cancel", sessionId: "b1e8", at: 1000 },
    { kind: "end", sessionId: "b1e8", generation: 3, at: 2000 },
  ]);
  expect(bad).toEqual([join(paths.pending, "cancel-5-x.json")]);
  for (const entry of entries) {
    expect(statSync(entry.file).mode & 0o777).toBe(0o600);
    removePending(entry);
  }
  expect(readdirSync(paths.pending)).toEqual(["cancel-5-x.json"]);
});

test("no pending folder: nothing", () => {
  expect(readPending(statePaths(join(root, "none")), () => undefined)).toEqual([]);
});
