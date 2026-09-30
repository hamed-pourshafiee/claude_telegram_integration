import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { MOST_RUNNING, NewSessions } from "../../src/broker/new-session.ts";
import type { Launched } from "../../src/broker/session-launch.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { Starts } from "../../src/broker/starts.ts";
import { parseConfig } from "../../src/shared/config.ts";
import type { LogFields } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";

// Plan 7.7 (D11): /new offers folders, asks for the first message, and starts `claude -p` there.
const dir = mkdtempSync(join(tmpdir(), "tg-new-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const work = join(dir, "work");
const at = (...parts: string[]) => join(work, ...parts);
for (const folder of ["sandbox", "app", "private", "gone", "other/app"]) {
  mkdirSync(at(folder), { recursive: true });
}
mkdirSync(join(dir, "elsewhere"));
const config = parseConfig(
  { serve: ["work"], content: { pingOnly: ["work/private"] } },
  { repoRoot: dir, home: dir },
);
const CHAT = 4242;
let files = 0;
let sessions: Sessions;
let starts: Starts;
let sent: SendMessageParams[];
let toasts: AnswerCallbackQueryParams[];
let launched: { id: string; folder: string; message: string }[];
let told: string[];
let audited: { event: string; fields: LogFields }[];
let exit: (code: number) => void;
let refuse: boolean;
let ids: number;
const RUNNING = new Set([101]);
let fresh: NewSessions;
beforeEach(() => {
  files += 1;
  const db = BrokerDb.open(join(dir, `new-${files}.db`));
  [sessions, starts] = [new Sessions(db), new Starts(db)];
  [sent, toasts, launched, told, audited, refuse, ids] = [[], [], [], [], [], false, 0];
  fresh = newSessions(config);
});

function newSessions(settings: typeof config): NewSessions {
  return new NewSessions({
    sessions,
    starts,
    telegram: {
      sendMessage: (params: SendMessageParams) => {
        if (refuse) return Promise.reject(new Error("Bad Request"));
        sent.push(params);
        return Promise.resolve({
          message_id: 70 + sent.length,
          date: 0,
          chat: { id: CHAT, type: "private" },
        });
      },
      answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
        toasts.push(params);
        return Promise.resolve();
      },
    },
    config: settings,
    launch: (id, folder, message): Launched => {
      launched.push({ id, folder, message });
      return { pid: 101, exited: new Promise<number>((resolve) => (exit = resolve)) };
    },
    senderName: () => "Hamed",
    tell: (text) => {
      told.push(text);
      return Promise.resolve();
    },
    log: () => undefined,
    audit: (event, fields) => audited.push({ event, fields }),
    alive: (pid) => RUNNING.has(pid),
    newId: () => `s-${++ids}`,
  });
}

/** A session that used the bridge in `folder`, its last stop `minutes` ago. */
function used(folder: string, minutes: number) {
  const id = `${folder.replace("/", "-")}-${minutes}`;
  sessions.touch({ id, projectDir: folder, entrypoint: "claude-vscode" });
  const clock = new Sessions(sessionsDb(), () => new Date(Date.now() - minutes * 60_000));
  clock.stop(id);
}
const sessionsDb = () => BrokerDb.open(join(dir, `new-${files}.db`));

const buttons = () =>
  (fresh.answer().reply_markup?.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);
const dataFor = (name: string) => buttons().find(([text]) => text === `📂 ${name}`)?.[1] ?? "";

/** Taps the folder and replies to the question with `text`. */
async function startIn(name: string, text: string) {
  await fresh.press(dataFor(name), CHAT, "q1");
  const question = starts.find(CHAT, 70 + sent.length);
  if (question === undefined) throw new Error(`no question for ${name}`);
  return fresh.start(text, question);
}

describe("the folders /new offers", () => {
  test("those of recent sessions, the one used last first: served, with text, and still there", () => {
    used(at("app"), 30);
    used(at("sandbox"), 5);
    used(at("private"), 1);
    used(join(dir, "elsewhere"), 2);
    used(at("other/app"), 60);
    used(at("gone"), 3);
    rmSync(at("gone"), { recursive: true });
    const answer = fresh.answer();
    expect(answer.text).toStartWith("📂 A new session: in which folder?");
    expect(buttons().map(([text]) => text)).toEqual(["📂 sandbox", "📂 work/app", "📂 other/app"]);
    expect(buttons().every(([, data]) => /^new:[0-9a-f]{16}$/.test(data ?? ""))).toBe(true);
  });

  test("none yet, or terminal sessions not served: it says so", () => {
    expect(fresh.answer()).toEqual({ text: expect.stringContaining("No folder to offer yet") });
    used(at("sandbox"), 5);
    const noCli = newSessions({ ...config, entrypoints: ["claude-vscode"] });
    expect(noCli.answer().text).toContain("doesn't serve those");
  });
});

describe("a tap on a folder, then the reply", () => {
  test("the reply box opens on a question for that folder; the reply starts the session there", async () => {
    used(at("sandbox"), 5);
    const started = await startIn("sandbox", "Fix the failing test");
    expect(sent[0]).toMatchObject({
      chat_id: CHAT,
      text: expect.stringMatching(/^✏️ Your first message for a new session in sandbox\n/),
      reply_markup: { force_reply: true, input_field_placeholder: "First message for sandbox" },
    });
    expect(toasts).toEqual([{ callback_query_id: "q1" }]);
    expect(started).toEqual({
      started: true,
      text: expect.stringMatching(/^🚀 Starting a session in sandbox/),
    });
    expect(launched).toEqual([
      {
        id: "s-1",
        folder: at("sandbox"),
        message: "📨 From Hamed on Telegram: Fix the failing test",
      },
    ]);
    expect(sessions.get("s-1")).toMatchObject({ fromChat: true, entrypoint: "cli", ended: false });
    expect(audited).toEqual([
      { event: "session.started", fields: { session: "s-1", folder: at("sandbox"), by: "chat" } },
    ]);
  });

  test("a second reply, or a folder gone since: nothing starts", async () => {
    used(at("sandbox"), 5);
    used(at("app"), 6);
    await startIn("sandbox", "first");
    const question = starts.find(CHAT, 71);
    expect(question && fresh.start("again", question)).toMatchObject({ started: false });
    await fresh.press(dataFor("app"), CHAT, "q2");
    rmSync(at("app"), { recursive: true });
    const late = starts.find(CHAT, 72);
    expect(late && fresh.start("hello", late)?.text).toBe("That folder isn't offered any more.");
    mkdirSync(at("app"));
    expect(launched).toHaveLength(1);
  });
});

describe("limits and failures", () => {
  test(`${MOST_RUNNING} running already: the tap, and a reply, are refused`, async () => {
    used(at("sandbox"), 5);
    for (let n = 0; n < MOST_RUNNING; n += 1) await startIn("sandbox", `task ${n}`);
    await fresh.press(dataFor("sandbox"), CHAT, "q9");
    expect(toasts.at(-1)?.text).toContain("still run");
    expect(launched).toHaveLength(MOST_RUNNING);
  });

  test("an unknown button, or a question the reply box can't open for", async () => {
    used(at("sandbox"), 5);
    await fresh.press("new:0000000000000000", CHAT, "q1");
    refuse = true;
    await fresh.press(dataFor("sandbox"), CHAT, "q2");
    expect(toasts.map((toast) => toast.text)).toEqual([
      "That folder isn't offered any more.",
      "The reply box didn't open. Try again.",
    ]);
  });

  test("a session that stops with an error: you hear of it, and it counts as ended", async () => {
    used(at("sandbox"), 5);
    await startIn("sandbox", "go");
    exit(127);
    await Bun.sleep(5);
    expect(told).toEqual([
      expect.stringMatching(/^⚠️ The session in sandbox stopped with an error \(exit code 127\)/),
    ]);
    expect(sessions.get("s-1")?.ended).toBe(true);
  });
});
