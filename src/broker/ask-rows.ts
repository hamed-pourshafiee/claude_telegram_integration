import type { Ask, AskedQuestion, AskState } from "./asks.ts";
import { parseAskInput } from "./questions.ts";

// The rows of the asks and ask_questions tables (schema 4), and the calls and questions they hold.

export interface AskRow {
  readonly id: string;
  readonly session_id: string;
  readonly tool_use_id: string;
  readonly pid: number;
  readonly claude_pid: number;
  readonly state: AskState;
  readonly input: string;
  readonly told: number;
  readonly created_at: number;
}

export interface QuestionRow {
  readonly ask_id: string;
  readonly idx: number;
  readonly chat_id: number | null;
  readonly message_id: number | null;
  readonly html: string;
  readonly picked: string;
  readonly answer: string | null;
}

export function fromRow(row: AskRow): Ask {
  let raw: unknown;
  try {
    raw = JSON.parse(row.input);
  } catch {
    raw = undefined; // written by this code, so this is a damaged row: the call counts as settled
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    toolUseId: row.tool_use_id,
    pid: row.pid,
    claudePid: row.claude_pid,
    state: row.state,
    input: parseAskInput(raw),
    told: row.told === 1,
    createdAt: row.created_at,
  };
}

export function questionFromRow(row: QuestionRow): AskedQuestion {
  let picked: unknown;
  try {
    picked = JSON.parse(row.picked);
  } catch {
    picked = [];
  }
  const list: readonly unknown[] = Array.isArray(picked) ? picked : [];
  return {
    askId: row.ask_id,
    index: row.idx,
    chatId: row.chat_id ?? undefined,
    messageId: row.message_id ?? undefined,
    html: row.html,
    picked: list.filter((item): item is number => typeof item === "number"),
    answer: row.answer ?? undefined,
  };
}
