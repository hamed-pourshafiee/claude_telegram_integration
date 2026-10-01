import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openWindows, parseJsonc } from "../../src/broker/vscode-windows.ts";
import type { LogFields } from "../../src/shared/log.ts";

// Plan 7.7 (F28): the windows VS Code has open, from its own state, for /new to offer.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "tg-windows-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const folder of ["bridge", "front", "api"]) mkdirSync(join(dir, folder));
const uri = (path: string) => pathToFileURL(path).href;
const workspace = join(dir, "studio.code-workspace");
writeFileSync(
  workspace,
  `{
  // VS Code writes comments and trailing commas here.
  "folders": [
    { "path": "front" },
    { "path": "api", },
    { "path": "../missing" }, /* gone since */
  ],
  "settings": { "remote.url": "https://example.com/a//b", "quote": "say \\"hi\\"" },
}`,
);
const state = join(dir, "storage.json");
writeFileSync(
  state,
  JSON.stringify({
    windowsState: {
      lastActiveWindow: { folder: uri(join(dir, "bridge")) },
      openedWindows: [
        { workspaceIdentifier: { id: "45ad", configURIPath: uri(workspace) } },
        { folder: uri(join(dir, "bridge")) },
        { folder: "vscode-remote://ssh-remote+box/home/project" },
      ],
    },
  }),
);
let logged: { event: string; fields: LogFields }[] = [];
const log = (event: string, fields: LogFields) => logged.push({ event, fields });

test("each open window once: a workspace runs in its first folder, with the others added; what each has open", () => {
  expect(openWindows(log, state, () => true)).toEqual([
    { name: "studio", folder: join(dir, "front"), addDirs: [join(dir, "api")], opened: workspace },
    { name: "bridge", folder: join(dir, "bridge"), addDirs: [], opened: join(dir, "bridge") },
  ]);
  expect(logged).toEqual([]);
});

test("VS Code not running: no windows, whatever its state still says", () => {
  expect(openWindows(log, state, () => false)).toEqual([]);
});

test("a state that can't be read: no windows, and the log says why", () => {
  logged = [];
  expect(openWindows(log, join(dir, "no-such.json"), () => true)).toEqual([]);
  expect(logged).toEqual([{ event: "vscode.unreadable", fields: { error: "ENOENT" } }]);
});

test("JSON with comments and trailing commas; strings kept as they are", () => {
  expect(
    parseJsonc('{ "a": [1, 2,], /* x */ "b": "http://x/*y*/", // end\n "c": "q\\"//", }'),
  ).toEqual({
    a: [1, 2],
    b: "http://x/*y*/",
    c: 'q"//',
  });
});
