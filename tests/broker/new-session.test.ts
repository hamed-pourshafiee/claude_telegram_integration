import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { MOST_RUNNING, NewSessions } from "../../src/broker/new-session.ts";
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

// Plan 7.7 (D11): /new offers the VS Code windows that are open, asks for the first message, and
// starts `claude -p` in the chosen window's folder.
const dir = mkdtempSync(join(tmpdir(), "tg-new-"));
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
/** The windows VS Code has open: a folder, and a workspace whose sessions run in its first folder. */
const BRIDGE: VsWindow = { name: "bridge", folder: at("bridge"), addDirs: [] };
const STUDIO: VsWindow = { name: "studio", folder: at("front"), addDirs: [at("api")] };
let files = 0;
let windows: VsWindow[];
let sessions: Sessions;
let starts: Starts;
let sent: SendMessageParams[];
let toasts: AnswerCallbackQueryParams[];
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
  [windows, sent, toasts, launched, told, audited] = [[BRIDGE, STUDIO], [], [], [], [], []];
  [refuse, ids] = [false, 0];
  fresh = newSessions();
});

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
    alive: (pid) => pid === 101,
    newId: () => `s-${++ids}`,
  });
}

const buttons = () =>
  (fresh.answer().reply_markup?.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);
const dataFor = (name: string) => buttons().find(([text]) => text === `🖥 ${name}`)?.[1] ?? "";

/** Taps the window and replies to the question with `text`. */
async function startIn(name: string, text: string) {
  await fresh.press(dataFor(name), CHAT, "q1");
  const question = starts.find(CHAT, 70 + sent.length);
  if (question === undefined) throw new Error(`no question for ${name}`);
  return fresh.start(text, question);
}

describe("the windows /new offers", () => {
  test("the open ones, in VS Code's order, whose folder is served, shows text and is still there", () => {
    const unserved = { name: "elsewhere", folder: join(dir, "elsewhere"), addDirs: [] };
    const pingOnly = { name: "private", folder: at("private"), addDirs: [] };
    const gone = { name: "gone", folder: at("gone"), addDirs: [] };
    windows = [BRIDGE, unserved, pingOnly, gone, STUDIO];
    rmSync(at("gone"), { recursive: true });
    expect(fresh.answer().text).toStartWith("🖥 A new session: in which VS Code window?");
    expect(buttons().map(([text]) => text)).toEqual(["🖥 bridge", "🖥 studio"]);
    expect(buttons().every(([, data]) => /^new:[0-9a-f]{16}$/.test(data ?? ""))).toBe(true);
    mkdirSync(at("gone"));
  });

  test("two of the same name get their folder's parent; none open says so", () => {
    windows = [BRIDGE, { name: "bridge", folder: at("other/bridge"), addDirs: [] }];
    expect(buttons().map(([text]) => text)).toEqual(["🖥 work/bridge", "🖥 other/bridge"]);
    windows = [];
    expect(fresh.answer()).toEqual({ text: expect.stringContaining("No VS Code window is open") });
  });
});

describe("a tap on a window, then the reply", () => {
  test("the reply box opens on a question for it; the reply starts the session in its folder", async () => {
    const started = await startIn("studio", "Fix the failing test");
    expect(sent[0]).toMatchObject({
      chat_id: CHAT,
      text: expect.stringMatching(/^✏️ Your first message for a new session in studio\n/),
      reply_markup: { force_reply: true, input_field_placeholder: "First message for studio" },
    });
    expect(toasts).toEqual([{ callback_query_id: "q1" }]);
    expect(started.started).toBe(true);
    expect(started.text).toStartWith("🚀 Starting a session in studio");
    expect(launched).toEqual([
      {
        id: "s-1",
        folder: at("front"),
        message: "📨 From Hamed on Telegram: Fix the failing test",
        addDirs: [at("api")],
      },
    ]);
    expect(sessions.get("s-1")).toMatchObject({ fromChat: true, ended: false });
    expect(audited).toEqual([
      { event: "session.started", fields: { session: "s-1", folder: at("front"), by: "chat" } },
    ]);
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
    expect(launched).toHaveLength(1);
  });
});

describe("limits and failures", () => {
  test(`${MOST_RUNNING} running already: the tap is refused`, async () => {
    for (let n = 0; n < MOST_RUNNING; n += 1) await startIn("bridge", `task ${n}`);
    await fresh.press(dataFor("bridge"), CHAT, "q9");
    expect(toasts.at(-1)?.text).toContain("still run");
    expect(launched).toHaveLength(MOST_RUNNING);
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

  test("a session that stops with an error: you hear of it, and it counts as ended", async () => {
    await startIn("bridge", "go");
    exit(127);
    await Bun.sleep(5);
    expect(told).toEqual([
      expect.stringMatching(/^⚠️ The session in bridge stopped with an error \(exit code 127\)/),
    ]);
    expect(sessions.get("s-1")?.ended).toBe(true);
  });
});
