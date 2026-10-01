import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOST_RUNNING } from "../../src/broker/background-sessions.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { NewSessions } from "../../src/broker/new-session.ts";
import type { Launched } from "../../src/broker/session-launch.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { Starts } from "../../src/broker/starts.ts";
import type { VsWindow } from "../../src/broker/vscode-windows.ts";
import { parseConfig } from "../../src/shared/config.ts";
import type { LogFields } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";
import { until } from "../helpers/wait.ts";

// Plans 7.7 and 7.8 (D11): /new offers the VS Code windows that are open and asks for the first
// message. The reply opens a new Claude tab in the chosen window, whose SessionStart gets the message
// (F30); with no tab in time, `claude -p` runs in the window's folder instead.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "tg-new-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const work = join(dir, "work");
const at = (...parts: string[]) => join(work, ...parts);
for (const folder of ["bridge", "front", "api", "private", "gone", "other/bridge"]) {
  mkdirSync(at(folder), { recursive: true });
}
mkdirSync(join(dir, "elsewhere"));
const config = parseConfig(
  { serve: ["work"], content: { pingOnly: ["work/private"] } },
  { repoRoot: dir, home: dir },
);
const CHAT = 4242;
const TAB_MS = 40; // how long a message waits for its tab here
/** A window with a folder open. */
const window = (name: string, folder: string): VsWindow => ({
  name,
  folder,
  addDirs: [],
  opened: folder,
});
/** The windows VS Code has open: a folder, and a workspace whose sessions run in its first folder. */
const BRIDGE = window("bridge", at("bridge"));
const STUDIO: VsWindow = {
  name: "studio",
  folder: at("front"),
  addDirs: [at("api")],
  opened: join(work, "studio.code-workspace"),
};
let files = 0;
let windows: VsWindow[];
let sessions: Sessions;
let starts: Starts;
let sent: SendMessageParams[];
let toasts: AnswerCallbackQueryParams[];
let tabs: VsWindow[];
let tabFails: boolean;
let launched: { id: string; folder: string; message: string; addDirs: readonly string[] }[];
let told: string[];
let audited: { event: string; fields: LogFields }[];
let exit: (code: number) => void;
let refuse: boolean;
let ids: number;
let fresh: NewSessions;
beforeEach(() => {
  files += 1;
  const db = BrokerDb.open(join(dir, `new-${files}.db`));
  [sessions, starts] = [new Sessions(db), new Starts(db)];
  [windows, sent, toasts, tabs, launched, told, audited] = [
    [BRIDGE, STUDIO],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
  [refuse, tabFails, ids] = [false, false, 0];
  fresh = newSessions();
});
// A message a test left waiting has gone to the background before the next test starts.
afterEach(() => Bun.sleep(TAB_MS + 20));

function newSessions(): NewSessions {
  return new NewSessions({
    sessions,
    starts,
    telegram: {
      sendMessage: (params: SendMessageParams) => {
        if (refuse) return Promise.reject(new Error("Bad Request"));
        sent.push(params);
        const chat = { id: CHAT, type: "private" };
        return Promise.resolve({ message_id: 70 + sent.length, date: 0, chat });
      },
      answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
        toasts.push(params);
        return Promise.resolve();
      },
    },
    config,
    windows: () => windows,
    openTab: (opened) => {
      tabs.push(opened);
      return tabFails ? Promise.reject(new Error("open exited with 1")) : Promise.resolve();
    },
    launch: (id, folder, message, addDirs): Launched => {
      launched.push({ id, folder, message, addDirs });
      return { pid: 101, exited: new Promise<number>((resolve) => (exit = resolve)) };
    },
    senderName: () => "Hamed",
    tell: (text) => {
      told.push(text);
      return Promise.resolve();
    },
    log: () => undefined,
    audit: (event, fields) => audited.push({ event, fields }),
    tabMs: TAB_MS,
    alive: (pid) => pid === 101,
    newId: () => `s-${++ids}`,
  });
}

const buttons = () =>
  (fresh.answer().reply_markup?.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);
const dataFor = (name: string) => buttons().find(([text]) => text === `🖥 ${name}`)?.[1] ?? "";
const first = (text: string) => `📨 From Hamed on Telegram: ${text}`;

/** Taps the window and replies to the question with `text`. */
async function startIn(name: string, text: string) {
  await fresh.press(dataFor(name), CHAT, "q1");
  const question = starts.find(CHAT, 70 + sent.length);
  if (question === undefined) throw new Error(`no question for ${name}`);
  return fresh.start(text, question);
}

/** A session's SessionStart in `folder`: a new VS Code tab's, unless said otherwise. */
const tabStarts = (id: string, folder: string, source = "startup", entrypoint = "claude-vscode") =>
  fresh.claim({ id, projectDir: folder, entrypoint }, source);

describe("the windows /new offers", () => {
  test("the open ones, in VS Code's order, whose folder is served, shows text and is still there", () => {
    const unserved = window("elsewhere", join(dir, "elsewhere"));
    windows = [
      BRIDGE,
      unserved,
      window("private", at("private")),
      window("gone", at("gone")),
      STUDIO,
    ];
    rmSync(at("gone"), { recursive: true });
    const which = "🖥 A new session: in which VS Code window?\nIt opens there as a new Claude tab";
    expect(fresh.answer().text).toStartWith(which);
    expect(buttons().map(([text]) => text)).toEqual(["🖥 bridge", "🖥 studio"]);
    expect(buttons().every(([, data]) => /^new:[0-9a-f]{16}$/.test(data ?? ""))).toBe(true);
    mkdirSync(at("gone"));
  });

  test("two of the same name get their folder's parent; none open says so", () => {
    windows = [BRIDGE, window("bridge", at("other/bridge"))];
    expect(buttons().map(([text]) => text)).toEqual(["🖥 work/bridge", "🖥 other/bridge"]);
    windows = [];
    expect(fresh.answer()).toEqual({ text: expect.stringContaining("No VS Code window is open") });
  });
});

describe("a tap on a window, then the reply", () => {
  test("the reply box opens on a question for it; the reply opens a new tab in that window", async () => {
    const started = await startIn("studio", "Fix the failing test");
    expect(sent[0]).toMatchObject({
      chat_id: CHAT,
      text: expect.stringMatching(/^✏️ Your first message for a new session in studio\n/),
      reply_markup: { force_reply: true, input_field_placeholder: "First message for studio" },
    });
    expect(toasts).toEqual([{ callback_query_id: "q1" }]);
    expect(started).toEqual({
      started: true,
      text: expect.stringMatching(/^🖥 Opening a new Claude tab in studio\. It starts on your/),
    });
    expect(tabs).toEqual([STUDIO]);
  });

  test("the tab's SessionStart gets the message, and the session counts as started here", async () => {
    await startIn("studio", "Fix the failing test");
    expect(tabStarts("t-1", at("front"))).toBe(first("Fix the failing test"));
    expect(sessions.get("t-1")).toMatchObject({ fromChat: true, inBackground: false });
    const fields = { session: "t-1", folder: at("front"), by: "chat", in: "tab" };
    expect(audited).toEqual([{ event: "session.started", fields }]);
    await Bun.sleep(TAB_MS + 20);
    expect([launched, told]).toEqual([[], []]);
  });

  test("only a new VS Code tab in that folder gets it, and only one; two wait in order", async () => {
    await startIn("bridge", "one");
    await startIn("bridge", "two");
    expect(tabStarts("r-1", at("bridge"), "resume")).toBeUndefined();
    expect(tabStarts("c-1", at("bridge"), "startup", "cli")).toBeUndefined();
    expect(tabStarts("o-1", at("front"))).toBeUndefined();
    expect(tabStarts("t-1", at("bridge"))).toBe(first("one"));
    expect(tabStarts("t-2", at("bridge"))).toBe(first("two"));
    expect(tabStarts("t-3", at("bridge"))).toBeUndefined();
    expect(["r-1", "c-1", "o-1"].some((id) => sessions.get(id))).toBe(false);
  });

  test("a second reply, or a folder gone since: nothing starts", async () => {
    await startIn("bridge", "first");
    const question = starts.find(CHAT, 71);
    expect(question && fresh.start("again", question)).toMatchObject({ started: false });
    await fresh.press(dataFor("studio"), CHAT, "q2");
    rmSync(at("front"), { recursive: true });
    const late = starts.find(CHAT, 72);
    expect(late && fresh.start("hello", late)?.text).toBe("That window isn't open any more.");
    mkdirSync(at("front"));
    expect(tabs).toEqual([BRIDGE]);
    expect(tabStarts("t-1", at("bridge"))).toBe(first("first"));
  });
});

describe("no tab: the session runs in the background (plan 7.7)", () => {
  test("none in time: `claude -p` in the window's folder, and you hear of it", async () => {
    await startIn("studio", "Fix the failing test");
    expect(await until(() => launched.length === 1)).toBe(true);
    const message = first("Fix the failing test");
    expect(launched).toEqual([{ id: "s-1", folder: at("front"), message, addDirs: [at("api")] }]);
    expect(sessions.get("s-1")).toMatchObject({ fromChat: true, inBackground: true });
    expect(told).toEqual([
      expect.stringMatching(
        /^⚠️ No Claude tab started in studio, so the session runs in the background/,
      ),
    ]);
    const fields = { session: "s-1", folder: at("front"), by: "chat", in: "background" };
    expect(audited).toEqual([{ event: "session.started", fields }]);
    expect(tabStarts("t-late", at("front"))).toBeUndefined();
  });

  test("a tab that can't open: in the background at once", async () => {
    tabFails = true;
    await startIn("bridge", "go");
    expect(await until(() => launched.length === 1, TAB_MS / 2)).toBe(true);
    expect(told).toEqual([expect.stringContaining("No Claude tab started in bridge")]);
    expect(tabStarts("t-1", at("bridge"))).toBeUndefined();
  });

  test("a window closed since the tap: in the background, with no tab", async () => {
    await fresh.press(dataFor("bridge"), CHAT, "q1");
    windows = [STUDIO];
    const question = starts.find(CHAT, 71);
    expect(question && fresh.start("go", question)).toEqual({
      started: true,
      text: expect.stringMatching(/^🚀 Starting a session in bridge, in the background\./),
    });
    expect(tabs).toEqual([]);
    expect(launched).toEqual([
      { id: "s-1", folder: at("bridge"), message: first("go"), addDirs: [] },
    ]);
  });
});

describe("limits and failures", () => {
  test(`${MOST_RUNNING} in the background already: no other there, and you hear why; tabs don't count`, async () => {
    for (const n of [1, 2, 3]) {
      await startIn("bridge", `tab ${n}`);
      tabStarts(`t-${n}`, at("bridge"));
    }
    tabFails = true;
    for (let n = 0; n < MOST_RUNNING; n += 1) await startIn("bridge", `task ${n}`);
    expect(await until(() => launched.length === MOST_RUNNING)).toBe(true);
    await startIn("bridge", "one more");
    expect(await until(() => told.length === MOST_RUNNING + 1)).toBe(true);
    expect(told.at(-1)).toBe(
      `${MOST_RUNNING} sessions started here still run in the background. Wait for one to end.`,
    );
    expect(launched).toHaveLength(MOST_RUNNING);
    tabFails = false;
    await startIn("bridge", "in a tab");
    expect(tabStarts("t-4", at("bridge"))).toBe(first("in a tab"));
  });

  test("an unknown button, or a question the reply box can't open for", async () => {
    await fresh.press("new:0000000000000000", CHAT, "q1");
    refuse = true;
    await fresh.press(dataFor("bridge"), CHAT, "q2");
    expect(toasts.map((toast) => toast.text)).toEqual([
      "That window isn't open any more.",
      "The reply box didn't open. Try again.",
    ]);
  });

  test("a session in the background that stops with an error: you hear of it, and it ends", async () => {
    tabFails = true;
    await startIn("bridge", "go");
    expect(await until(() => launched.length === 1)).toBe(true);
    exit(127);
    expect(await until(() => told.length === 2)).toBe(true);
    expect(told[1]).toMatch(/^⚠️ The session in bridge stopped with an error \(exit code 127\)/);
    expect(sessions.get("s-1")?.ended).toBe(true);
  });
});
