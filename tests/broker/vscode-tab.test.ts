import { describe, expect, test } from "bun:test";
import {
  execute,
  NEW_TAB_LINK,
  openTab,
  type PendingTab,
  PendingTabs,
  tabCommands,
} from "../../src/broker/vscode-tab.ts";
import type { VsWindow } from "../../src/broker/vscode-windows.ts";

// Plan 7.8 (D11): the tab /new opens, in the window you picked, and the first messages waiting for it.
const APP = "/Applications/Visual Studio Code.app";
const BRIDGE: VsWindow = {
  name: "bridge",
  folder: "/work/bridge",
  addDirs: [],
  opened: "/work/bridge",
};
const STUDIO: VsWindow = {
  name: "studio",
  folder: "/work/front",
  addDirs: ["/work/api"],
  opened: "/work/studio.code-workspace",
};

describe("opening a tab", () => {
  test("the window brought forward by what it has open, a folder or a workspace, then the link", () => {
    expect(NEW_TAB_LINK).toBe("vscode://anthropic.claude-code/open");
    expect(tabCommands(APP, BRIDGE)).toEqual([
      ["/usr/bin/open", "-a", APP, "/work/bridge"],
      ["/usr/bin/open", NEW_TAB_LINK],
    ]);
    expect(tabCommands(APP, STUDIO)[0]).toEqual([
      "/usr/bin/open",
      "-a",
      APP,
      "/work/studio.code-workspace",
    ]);
  });

  test("both run, in order, with a pause between; the first to fail stops it", async () => {
    const ran: string[][] = [];
    let fail = false;
    const exec = (cmd: readonly string[]) => {
      ran.push([...cmd]);
      return fail ? Promise.reject(new Error("open exited with 1")) : Promise.resolve();
    };
    const started = Date.now();
    await openTab(() => APP, 30, exec)(STUDIO);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(ran).toEqual(tabCommands(APP, STUDIO));
    [ran.length, fail] = [0, true];
    await expect(openTab(() => APP, 30, exec)(STUDIO)).rejects.toThrow("open exited with 1");
    expect(ran).toEqual([tabCommands(APP, STUDIO)[0]]);
  });

  test("VS Code not running: no tab, and why", async () => {
    const exec = () => Promise.reject(new Error("never run"));
    await expect(openTab(() => undefined, 0, exec)(BRIDGE)).rejects.toThrow(
      "VS Code isn't running",
    );
  });

  test("a command that fails says so, with its exit code", async () => {
    await expect(execute(["/usr/bin/true"])).resolves.toBeUndefined();
    await expect(execute(["/usr/bin/false"])).rejects.toThrow("/usr/bin/false exited with 1");
  });
});

describe("the messages waiting for their tabs", () => {
  const tab = (window: VsWindow, message: string): PendingTab => ({
    window,
    folder: window.folder,
    name: window.name,
    message,
  });

  test("a tab in a folder takes the message that has waited longest there", () => {
    const tabs = new PendingTabs();
    const late: PendingTab[] = [];
    const [first, other, second] = [tab(BRIDGE, "one"), tab(STUDIO, "studio"), tab(BRIDGE, "two")];
    for (const waiting of [first, other, second]) tabs.add(waiting, 60_000, (t) => late.push(t));
    expect(tabs.take("/work/bridge")).toBe(first);
    expect(tabs.take("/work/bridge")).toBe(second);
    expect(tabs.take("/work/bridge")).toBeUndefined();
    expect(tabs.size).toBe(1);
    expect(tabs.remove(other)).toBe(true);
    expect(tabs.remove(other)).toBe(false);
    expect([tabs.size, late.length]).toEqual([0, 0]);
  });

  test("one no tab took in time goes to `late`, once; one taken never does", async () => {
    const tabs = new PendingTabs();
    const late: string[] = [];
    tabs.add(tab(BRIDGE, "waits"), 20, (t) => late.push(t.message));
    tabs.add(tab(STUDIO, "taken"), 20, (t) => late.push(t.message));
    tabs.take("/work/front");
    await Bun.sleep(50);
    expect(late).toEqual(["waits"]);
    expect(tabs.take("/work/bridge")).toBeUndefined();
  });
});
