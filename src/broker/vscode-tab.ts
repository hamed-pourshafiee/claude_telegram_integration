import { type VsWindow, vsCodeApp } from "./vscode-windows.ts";

/** The link that opens a new Claude Code tab, in the window VS Code used last (F23). */
export const NEW_TAB_LINK = "vscode://anthropic.claude-code/open";
/** How Claude Code names a session in a VS Code tab (CLAUDE_CODE_ENTRYPOINT). */
export const TAB_ENTRYPOINT = "claude-vscode";
/** How long VS Code gets to bring the window forward before the link comes. */
const FOCUS_MS = 1000;

/** Opens a new Claude Code tab in `window` (D11, plan 7.8); throws when it can't. */
export type OpenTab = (window: VsWindow) => Promise<void>;

/**
 * The commands that open the tab: the window's folder or workspace opened again, which VS Code answers
 * by bringing forward the window that has it open, then the link, which goes to the window used last.
 */
export function tabCommands(app: string, window: Pick<VsWindow, "opened">): [string[], string[]] {
  return [
    ["/usr/bin/open", "-a", app, window.opened],
    ["/usr/bin/open", NEW_TAB_LINK],
  ];
}

/** Runs a command; throws, with the start of its stderr, when it fails. */
export type Exec = (cmd: readonly string[]) => Promise<void>;

/** Opens tabs in the VS Code that runs, `focusMs` after bringing the window forward. */
export function openTab(
  app: () => string | undefined = vsCodeApp,
  focusMs = FOCUS_MS,
  exec: Exec = execute,
): OpenTab {
  return async (window) => {
    const running = app();
    if (running === undefined) throw new Error("VS Code isn't running");
    const [focus, link] = tabCommands(running, window);
    await exec(focus);
    await Bun.sleep(focusMs);
    await exec(link);
  };
}

export const execute: Exec = async (cmd) => {
  const child = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}: ${stderr.trim().slice(0, 200)}`);
};

/** A first message waiting for the tab /new opened for it (plan 7.8). */
export interface PendingTab {
  readonly window: VsWindow;
  /** The window's folder, resolved, as the tab's hooks will name it (CLAUDE_PROJECT_DIR, F15). */
  readonly folder: string;
  readonly name: string;
  readonly message: string;
}

/** The first messages waiting for their tabs, oldest first, each for a while. */
export class PendingTabs {
  readonly #waiting = new Map<PendingTab, ReturnType<typeof setTimeout>>();

  /** Waits `ms` for the tab; then `late` gets the message, unless a tab took it first. */
  add(tab: PendingTab, ms: number, late: (tab: PendingTab) => void): void {
    const timer = setTimeout(() => {
      if (this.#waiting.delete(tab)) late(tab);
    }, ms);
    // A message waiting never keeps a process alive on its own: a test's, say.
    timer.unref();
    this.#waiting.set(tab, timer);
  }

  /** The message that has waited longest in `folder`, which waits no more. */
  take(folder: string): PendingTab | undefined {
    for (const tab of this.#waiting.keys()) {
      if (tab.folder === folder && this.remove(tab)) return tab;
    }
    return undefined;
  }

  /** Stops waiting for `tab`'s tab; whether it still waited. */
  remove(tab: PendingTab): boolean {
    const timer = this.#waiting.get(tab);
    if (timer === undefined) return false;
    clearTimeout(timer);
    return this.#waiting.delete(tab);
  }

  get size(): number {
    return this.#waiting.size;
  }
}
