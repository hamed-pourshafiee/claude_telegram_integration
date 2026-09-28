import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullTexts } from "../../src/broker/full-texts.ts";
import { finishNotice } from "../../src/broker/notices.ts";
import { Notifier } from "../../src/broker/notifier.ts";
import type { PairedUser } from "../../src/broker/pairing.ts";
import type { Snapshot } from "../../src/broker/presence.ts";
import { parseConfig } from "../../src/shared/config.ts";
import type { LogFields } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  SendDocumentParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";
import { SAMPLES } from "../helpers/secret-samples.ts";

// Plan 2.7: notices go to the paired user only while they are away and not muted (D4); text is
// redacted and cut (D8), and a cut reply's 📄 button sends it whole.
const dir = mkdtempSync(join(tmpdir(), "tg-notifier-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const folder of ["sandbox", "private"]) mkdirSync(join(dir, folder));
const config = parseConfig(
  { serve: ["sandbox", "private"], content: { pingOnly: ["private"], maxChars: 300 } },
  { repoRoot: dir, home: dir },
);
const session = (folder: string) => ({
  id: "b1e81638-e169",
  projectDir: join(dir, folder),
  entrypoint: "cli",
  branch: "main",
  generation: 1,
  ended: false,
});
const away: Snapshot = {
  mode: "auto",
  state: "away",
  because: "locked",
  idleSeconds: 9,
  locked: true,
};

let sent: SendMessageParams[];
let documents: SendDocumentParams[];
let answers: AnswerCallbackQueryParams[];
let logged: string[];
let snapshot: Snapshot;
let user: PairedUser | undefined;
beforeEach(() => {
  [sent, documents, answers, logged] = [[], [], [], []];
  snapshot = away;
  user = { id: 4242, name: "Hamed (@someone)" };
});

const chat = { id: 4242, type: "private" };
const notifier = new Notifier({
  telegram: {
    sendMessage: (params) => {
      sent.push(params);
      return Promise.resolve({ message_id: sent.length, date: 0, chat });
    },
    sendDocument: (params) => {
      documents.push(params);
      return Promise.resolve({ message_id: 99, date: 0, chat });
    },
    answerCallbackQuery: (params) => {
      answers.push(params);
      return Promise.resolve();
    },
  },
  pairing: { pairedUser: () => user },
  presence: { snapshot: () => snapshot },
  config,
  log: (event: string, fields: LogFields) => logged.push(JSON.stringify({ event, ...fields })),
  fullTexts: new FullTexts(),
});
const finish = (text: string) => (name: string, mode: "full" | "ping-only") =>
  finishNotice(name, text, [], mode);

describe("who gets a notice, and when", () => {
  const arrangements: readonly (readonly [string, () => void, string])[] = [
    [
      "not paired",
      () => {
        user = undefined;
      },
      "not paired",
    ],
    [
      "/off",
      () => {
        snapshot = { ...away, mode: "off" };
      },
      "muted",
    ],
    [
      "at the Mac",
      () => {
        snapshot = { ...away, state: "active", because: "input" };
      },
      "at the Mac",
    ],
    [
      "in between",
      () => {
        snapshot = { ...away, state: "between", because: "idle" };
      },
      "in between",
    ],
  ];
  test.each(arrangements)("%s: nothing is sent", async (_, arrange, reason) => {
    arrange();
    expect(await notifier.send("finish", session("sandbox"), finish("hi"))).toBe(false);
    expect(sent).toEqual([]);
    expect(logged.at(-1)).toContain(`"reason":"${reason}"`);
  });

  test("away (or /away): the notice goes to the paired user's chat, in HTML, logged without text", async () => {
    expect(await notifier.send("finish", session("sandbox"), finish("Say <hi> & bye"))).toBe(true);
    expect(sent).toEqual([
      {
        chat_id: 4242,
        text: "<b>✅ sandbox (main) · b1e8</b>\n\nSay &lt;hi&gt; &amp; bye",
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    ]);
    expect(logged.join("\n")).not.toContain("Say");
  });
});

describe("what leaves the Mac (D8)", () => {
  test("secrets are masked, in the chat and in the file; a ping-only folder sends no text", async () => {
    const secrets = SAMPLES.map((sample) => sample.line).join("\n");
    await notifier.send("finish", session("sandbox"), finish(secrets));
    const button = sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0];
    await notifier.press(button?.callback_data ?? "", 4242, "q0");
    await notifier.send("finish", session("private"), finish("The private plan."));
    const text = [...sent.map((message) => message.text), documents[0]?.content].join("\n");
    expect(documents).toHaveLength(1);
    for (const sample of SAMPLES) expect(text).not.toContain(sample.secret);
    expect(text).not.toContain("private plan");
  });

  test("a long reply is cut, and its 📄 button sends the whole of it as a file", async () => {
    const long = `${"word ".repeat(200)}END`;
    await notifier.send("finish", session("sandbox"), finish(long));
    const button = sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("📄 Full text as a file");
    expect(sent.at(-1)?.text).not.toContain("END");
    await notifier.press(button?.callback_data ?? "", 4242, "q1");
    expect(answers).toEqual([{ callback_query_id: "q1" }]);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.content).toEndWith("END");
    expect(documents[0]?.filename).toMatch(/^sandbox-b1e8-.+\.md$/);
  });

  test("a button whose text is gone: an alert, and no file", async () => {
    await notifier.press("full:0123456789abcdef", 4242, "q2");
    expect(answers).toEqual([
      {
        callback_query_id: "q2",
        text: expect.stringContaining("no longer kept"),
        show_alert: true,
      },
    ]);
    expect(documents).toEqual([]);
  });
});
