import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { askWhere } from "../../src/broker/ask-calls.ts";
import { AskChat } from "../../src/broker/ask-chat.ts";
import { AskMessages } from "../../src/broker/ask-messages.ts";
import { AskRelay } from "../../src/broker/ask-relay.ts";
import { Asks } from "../../src/broker/asks.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { formatReply } from "../../src/broker/format.ts";
import type { Notice } from "../../src/broker/notices.ts";
import type { NoticeOf } from "../../src/broker/notifier.ts";
import type { Mode, Snapshot, State } from "../../src/broker/presence.ts";
import { label, type Session, Sessions } from "../../src/broker/sessions.ts";
import { parseConfig } from "../../src/shared/config.ts";
import { type LogFields, noLog } from "../../src/shared/log.ts";
import type {
  AnswerCallbackQueryParams,
  EditMessageReplyMarkupParams,
  EditMessageTextParams,
  InlineKeyboardButton,
  SendDocumentParams,
  SendMessageParams,
} from "../../src/shared/telegram/types.ts";

// Plan 4.1: the broker's side of Claude's questions, on a real database, with a stand-in chat.

export const CHAT = 4242;
/**
 * Served folders that exist, as they must (D8): private/ is ping-only. Several test files share this
 * module, so the folders go when the test process ends, not after the first file.
 */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tg-asks-root-")));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
export const FOLDERS = { sandbox: join(ROOT, "sandbox"), private: join(ROOT, "private") };
for (const folder of Object.values(FOLDERS)) mkdirSync(folder);
export const SESSION = {
  session_id: "5e551011-aaaa",
  project_dir: FOLDERS.sandbox,
  entrypoint: "claude-vscode",
};
const config = parseConfig(
  { serve: [ROOT], content: { pingOnly: [FOLDERS.private] } },
  { repoRoot: ROOT, home: ROOT },
);

/** A question's message as the notifier sent it. */
export interface PostedQuestion extends Notice {
  readonly rows: readonly (readonly InlineKeyboardButton[])[];
  readonly messageId: number;
  /** Sent whole, never cut (a permission prompt, D9). */
  readonly whole: boolean;
}

export interface AskHarness {
  readonly db: BrokerDb;
  readonly sessions: Sessions;
  readonly relay: AskRelay;
  readonly chat: AskChat;
  readonly asks: Asks;
  /** The questions' messages, in order. */
  readonly posted: PostedQuestion[];
  /** Notices sent only while away: "waiting at the computer". */
  readonly told: Notice[];
  readonly edits: EditMessageTextParams[];
  readonly markups: EditMessageReplyMarkupParams[];
  readonly toasts: AnswerCallbackQueryParams[];
  readonly sent: SendMessageParams[];
  readonly documents: SendDocumentParams[];
  /** The audit log's lines (D9): event and fields. */
  readonly audited: { readonly event: string; readonly fields: LogFields }[];
  readonly hurried: () => boolean;
  /** You're now in `state`: presence tells the chat side, as in the broker. */
  readonly be: (state: State, mode?: Mode) => void;
  /** A question hook asks for its call: the answer to its Ask, which may wait. */
  readonly ask: (toolUseId: string, input: unknown, options?: AskOptions) => Promise<Answer>;
  /** The id of a recorded call. */
  readonly idOf: (toolUseId: string) => string;
}

export interface AskOptions {
  readonly pid?: number;
  readonly projectDir?: string;
}

function snapshot(state: State, mode: Mode): Snapshot {
  const because = mode === "away" ? "away mode" : state === "active" ? "input" : "idle";
  return { mode, state, because, idleSeconds: 0, locked: false };
}

/** The parts on the database in `file` (the same file again: a restarted broker); edits take `editMs`. */
export function askHarness(
  file: string,
  dead: ReadonlySet<number> = new Set(),
  editMs = 0,
): AskHarness {
  const db = BrokerDb.open(file);
  const sessions = new Sessions(db);
  const asks = new Asks(db);
  let now = snapshot("away", "auto");
  let hurried = false;
  const presence = { snapshot: () => now, hurry: (on: boolean) => (hurried = on) };
  const record = recorder(editMs);
  const messages = new AskMessages({ asks, ...record.parts, log: noLog });
  const pairing = { pairedUser: () => ({ id: CHAT, name: "Hamed (@someone)" }) };
  const where = askWhere({ pairing, presence, config });
  const onLocal = (ask: Parameters<AskChat["localNow"]>[0]) => chat.localNow(ask);
  const common = { sessions, asks, messages, presence, log: noLog, audit: record.audit };
  const alive = (pid: number) => !dead.has(pid);
  const relay = new AskRelay({ ...common, where, onLocal, holdMs: 60_000, alive });
  const chat = new AskChat({ ...common, relay, telegram: record.parts.telegram });
  return {
    db,
    sessions,
    relay,
    chat,
    asks,
    ...record.lists,
    hurried: () => hurried,
    be: (state, mode = "auto") => {
      const before = now.state;
      now = snapshot(state, mode);
      if (before !== state) chat.presenceChanged(now, before);
    },
    ask: (toolUseId, input, options = {}) => {
      const projectDir = options.projectDir ?? SESSION.project_dir;
      sessions.touch({ id: SESSION.session_id, projectDir, entrypoint: SESSION.entrypoint });
      const call = { ...SESSION, project_dir: projectDir, tool_use_id: toolUseId, input };
      return Promise.resolve(relay.ask({ ...call, pid: options.pid ?? 11, claude_pid: 22 }));
    },
    idOf: (toolUseId) => asks.find(SESSION.session_id, toolUseId)?.id ?? "unknown",
  };
}

/** What the stand-ins were asked to send, and the audit log's lines. */
function emptyLists() {
  return {
    posted: [] as PostedQuestion[],
    told: [] as Notice[],
    edits: [] as EditMessageTextParams[],
    markups: [] as EditMessageReplyMarkupParams[],
    toasts: [] as AnswerCallbackQueryParams[],
    sent: [] as SendMessageParams[],
    documents: [] as SendDocumentParams[],
    audited: [] as { event: string; fields: LogFields }[],
  };
}

/** The notifier's stand-in: a question's messages, numbered from 101, and the notices it sends. */
function fakeNotifier(lists: ReturnType<typeof emptyLists>) {
  let messageId = 100;
  return {
    post: (
      _chat: number,
      _kind: string,
      session: Session,
      noticeOf: NoticeOf,
      rows = [],
      options: { readonly whole?: boolean } = {},
    ) => {
      const notice = noticeOf(label(session), "full");
      // A long one goes in several messages, as the notifier sends it (D8; D9 for a whole one).
      const maxChars = options.whole === true ? Number.MAX_SAFE_INTEGER : config.content.maxChars;
      const parts = formatReply(notice.header, notice.body, maxChars).messages.length;
      const sent = Array.from({ length: parts }, (_, at) => {
        messageId += 1;
        return { messageId, html: at === 0 ? `<b>${notice.header}</b>` : `part ${at + 1}` };
      });
      lists.posted.push({ ...notice, rows, messageId, whole: options.whole === true });
      return Promise.resolve(sent);
    },
    send: (_kind: string, session: Session, noticeOf: NoticeOf) => {
      lists.told.push(noticeOf(label(session), "full"));
      return Promise.resolve(true);
    },
  };
}

/** A stand-in notifier and Telegram client that keep what they were asked to send. */
function recorder(editMs: number) {
  const lists = emptyLists();
  const audit = (event: string, fields: LogFields) => lists.audited.push({ event, fields });
  const message = (chatId: number) => ({
    message_id: 1,
    date: 0,
    chat: { id: chatId, type: "private" },
  });
  const telegram = {
    sendMessage: (params: SendMessageParams) => {
      lists.sent.push(params);
      return Promise.resolve(message(params.chat_id));
    },
    editMessageText: async (params: EditMessageTextParams) => {
      lists.edits.push(params);
      await Bun.sleep(editMs);
      return message(params.chat_id);
    },
    editMessageReplyMarkup: (params: EditMessageReplyMarkupParams) => {
      lists.markups.push(params);
      return Promise.resolve(message(params.chat_id));
    },
    answerCallbackQuery: (params: AnswerCallbackQueryParams) => {
      lists.toasts.push(params);
      return Promise.resolve();
    },
    sendDocument: (params: SendDocumentParams) => {
      lists.documents.push(params);
      return Promise.resolve(message(params.chat_id));
    },
  };
  return { lists, parts: { notifier: fakeNotifier(lists), telegram }, audit };
}
