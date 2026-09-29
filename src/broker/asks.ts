import type { BrokerDb } from "./db.ts";
import { type AskInput, parseAskInput } from "./questions.ts";

/**
 * Where a call's questions are (plan 4.1): on Telegram (remote), all answered there, delivered to its
 * hook, or at the Mac (local, in the dialog); closed once Claude has its answers or the turn moved on,
 * ended when its hook stopped waiting first.
 */
export type AskState = "remote" | "answered" | "delivered" | "local" | "closed" | "ended";

/** One AskUserQuestion call, asked by one PreToolUse hook. */
export interface Ask {
  readonly id: string;
  readonly sessionId: string;
  readonly toolUseId: string;
  /** The hook's process and its Claude's, checked at broker start. */
  readonly pid: number;
  readonly claudePid: number;
  readonly state: AskState;
  /** The questions; none once the call is settled. */
  readonly input: AskInput | undefined;
  /** Whether you were told it waits at the computer (flow 3). */
  readonly told: boolean;
  readonly createdAt: number;
}

/** A question of a call, with its message in the chat and your answer. */
export interface AskedQuestion {
  readonly askId: string;
  readonly index: number;
  readonly chatId: number | undefined;
  readonly messageId: number | undefined;
  /** The message as sent (HTML), kept for edits until the call is settled. */
  readonly html: string;
  /** A multi-select's options picked so far. */
  readonly picked: readonly number[];
  readonly answer: string | undefined;
}

export type NewAsk = Omit<Ask, "told" | "createdAt" | "input"> & {
  /** The questions as Claude wrote them: `title` and `questions`. */
  readonly raw: string;
  readonly count: number;
};

interface AskRow {
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

interface QuestionRow {
  readonly ask_id: string;
  readonly idx: number;
  readonly chat_id: number | null;
  readonly message_id: number | null;
  readonly html: string;
  readonly picked: string;
  readonly answer: string | null;
}

/** How long a settled call is kept, for its buttons to say "expired". */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Claude's questions in the broker's database (plan 4.1). Every move of a call is one UPDATE from the
 * states it may leave, so an answer from Telegram and a hand-back to the Mac can't both win.
 */
export class Asks {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Records a call, with a row per question; the one already recorded, when its hook asks again. */
  create(ask: NewAsk): Ask {
    return this.#db.transaction(() => {
      const known = this.find(ask.sessionId, ask.toolUseId);
      if (known !== undefined) return known;
      this.#db.run(
        `INSERT INTO asks (id, session_id, tool_use_id, pid, claude_pid, state, input, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ask.id,
        ask.sessionId,
        ask.toolUseId,
        ask.pid,
        ask.claudePid,
        ask.state,
        ask.raw,
        this.#now(),
      );
      for (let index = 0; index < ask.count; index += 1) {
        this.#db.run("INSERT INTO ask_questions (ask_id, idx) VALUES (?, ?)", ask.id, index);
      }
      const created = this.get(ask.id);
      if (created === undefined) throw new Error(`ask ${ask.id} was not recorded`);
      return created;
    });
  }

  get(id: string): Ask | undefined {
    const row = this.#db.get<AskRow>("SELECT * FROM asks WHERE id = ?", id);
    return row === undefined ? undefined : fromRow(row);
  }

  find(sessionId: string, toolUseId: string): Ask | undefined {
    const row = this.#db.get<AskRow>(
      "SELECT * FROM asks WHERE session_id = ? AND tool_use_id = ?",
      sessionId,
      toolUseId,
    );
    return row === undefined ? undefined : fromRow(row);
  }

  /** Calls in one of `states`, oldest first; of one session, if given. */
  inState(states: readonly AskState[], sessionId?: string): Ask[] {
    const marks = states.map(() => "?").join(", ");
    const bySession = sessionId === undefined ? "" : " AND session_id = ?";
    return this.#db
      .all<AskRow>(
        `SELECT * FROM asks WHERE state IN (${marks})${bySession} ORDER BY created_at, id`,
        ...states,
        ...(sessionId === undefined ? [] : [sessionId]),
      )
      .map(fromRow);
  }

  /** Moves the call to `to` if it is in one of `from`; whether it moved. */
  move(id: string, from: readonly AskState[], to: AskState): boolean {
    const marks = from.map(() => "?").join(", ");
    return (
      this.#db.run(
        `UPDATE asks SET state = ? WHERE id = ? AND state IN (${marks})`,
        to,
        id,
        ...from,
      ) === 1
    );
  }

  setTold(id: string): void {
    this.#db.run("UPDATE asks SET told = 1 WHERE id = ?", id);
  }

  questions(askId: string): AskedQuestion[] {
    return this.#db
      .all<QuestionRow>("SELECT * FROM ask_questions WHERE ask_id = ? ORDER BY idx", askId)
      .map(questionFromRow);
  }

  /** The question whose message this is. */
  at(chatId: number, messageId: number): AskedQuestion | undefined {
    const row = this.#db.get<QuestionRow>(
      "SELECT * FROM ask_questions WHERE chat_id = ? AND message_id = ?",
      chatId,
      messageId,
    );
    return row === undefined ? undefined : questionFromRow(row);
  }

  /**
   * The question's message, as it now reads. Its text isn't kept once the call is settled (D8): an edit
   * can finish after PostToolUse closed the call.
   */
  shown(
    askId: string,
    index: number,
    message: { chatId: number; messageId: number; html: string },
  ) {
    this.#db.run(
      `UPDATE ask_questions SET chat_id = ?, message_id = ?, html = CASE
         WHEN (SELECT state FROM asks WHERE id = ask_id) IN ('closed', 'ended') THEN '' ELSE ? END
       WHERE ask_id = ? AND idx = ?`,
      message.chatId,
      message.messageId,
      message.html,
      askId,
      index,
    );
  }

  /** A multi-select's picks, while the call is on Telegram and the question unanswered; whether kept. */
  pick(askId: string, index: number, picked: readonly number[]): boolean {
    return (
      this.#db.run(
        `UPDATE ask_questions SET picked = ? WHERE ask_id = ? AND idx = ? AND answer IS NULL
         AND (SELECT state FROM asks WHERE id = ask_id) = 'remote'`,
        JSON.stringify(picked),
        askId,
        index,
      ) === 1
    );
  }

  /**
   * Your answer to a question of a call on Telegram: "recorded", "complete" when it was the last one (the
   * call is then answered), or "closed" when the call has left Telegram or the question has its answer.
   */
  answer(askId: string, index: number, answer: string): "recorded" | "complete" | "closed" {
    return this.#db.transaction(() => {
      if (this.get(askId)?.state !== "remote") return "closed";
      const recorded = this.#db.run(
        "UPDATE ask_questions SET answer = ? WHERE ask_id = ? AND idx = ? AND answer IS NULL",
        answer,
        askId,
        index,
      );
      if (recorded !== 1) return "closed";
      const open = this.#db.get<{ n: number }>(
        "SELECT count(*) AS n FROM ask_questions WHERE ask_id = ? AND answer IS NULL",
        askId,
      );
      if ((open?.n ?? 0) > 0) return "recorded";
      return this.move(askId, ["remote"], "answered") ? "complete" : "closed";
    });
  }

  /** The answers of an answered call, by question text, as AskUserQuestion takes them (F4). */
  answers(ask: Ask): Record<string, string> | undefined {
    const questions = ask.input?.questions ?? [];
    const answers: Record<string, string> = {};
    for (const asked of this.questions(ask.id)) {
      const question = questions[asked.index];
      if (question === undefined || asked.answer === undefined) return undefined;
      answers[question.text] = asked.answer;
    }
    return Object.keys(answers).length === questions.length ? answers : undefined;
  }

  /** Drops a settled call's text (D8): its questions and its messages as sent. */
  forget(id: string): void {
    this.#db.transaction(() => {
      this.#db.run("UPDATE asks SET input = '{}' WHERE id = ?", id);
      this.#db.run("UPDATE ask_questions SET html = '', answer = NULL WHERE ask_id = ?", id);
    });
  }

  /** Forgets calls older than a week; how many. */
  prune(): number {
    return this.#db.transaction(() => {
      const before = this.#now() - KEEP_MS;
      this.#db.run(
        "DELETE FROM ask_questions WHERE ask_id IN (SELECT id FROM asks WHERE created_at < ?)",
        before,
      );
      return this.#db.run("DELETE FROM asks WHERE created_at < ?", before);
    });
  }
}

function fromRow(row: AskRow): Ask {
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

function questionFromRow(row: QuestionRow): AskedQuestion {
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
