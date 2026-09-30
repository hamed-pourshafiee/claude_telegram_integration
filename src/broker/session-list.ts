import { processAlive } from "../shared/process.ts";
import type { InlineKeyboardButton } from "../shared/telegram/types.ts";
import type { Ask, Asks } from "./asks.ts";
import { type CommandAnswer, duration } from "./commands.ts";
import { labels, type Session, type Sessions } from "./sessions.ts";
import type { Waiter, Waiters } from "./waiters.ts";

export interface SessionListDeps {
  readonly sessions: Pick<Sessions, "open">;
  readonly waiters: Pick<Waiters, "listening">;
  readonly asks: Pick<Asks, "inState">;
  /** Whether a process runs; default: a signal-0 kill. */
  readonly alive?: (pid: number) => boolean;
  /**
   * A running session's title as it is now, read from its transcript (plan 7.5): a hook may not have run
   * since Claude Code made it (F21). Without it, or when it has none, the title kept is used.
   */
  readonly titleOf?: (session: Session) => string | undefined;
  readonly now?: () => number;
}

/** What a session is doing, in the order the list shows them: what needs you first. */
export type Doing =
  | { readonly kind: "asks"; readonly ask: Ask }
  | { readonly kind: "listening"; readonly since: number }
  | { readonly kind: "at-mac"; readonly ask: Ask }
  | { readonly kind: "working"; readonly since: number }
  | { readonly kind: "idle"; readonly since: number };

/** A session as /sessions lists it, with the name the list gives it. */
export interface Listed {
  readonly session: Session;
  readonly doing: Doing;
  readonly name: string;
}

const ORDER: readonly Doing["kind"][] = ["asks", "listening", "at-mac", "working", "idle"];
/** The most sessions one message lists. */
const MOST = 30;
/** A session's button: "write:<id>" (plan 7.4), within the 64 bytes Telegram allows. */
const ID = /^[\w-]{1,40}$/;

/**
 * The open sessions, what needs you first (plan 7.3). A session counts as open until its SessionEnd,
 * which a crash never sends, so only those whose Claude still runs are listed (F18): the session's
 * own, or that of a hook waiting for you. Each is named by its title as it is now; sessions of the same
 * title get the start of their id.
 */
export function listed(deps: SessionListDeps): Listed[] {
  const alive = deps.alive ?? processAlive;
  const listening = new Map(deps.waiters.listening().map((waiter) => [waiter.sessionId, waiter]));
  const asks = deps.asks.inState(["remote", "local"]);
  const rows = deps.sessions
    .open()
    .filter((session) => {
      const pids = [session.claudePid, listening.get(session.id)?.claudePid];
      for (const ask of asks) if (ask.sessionId === session.id) pids.push(ask.claudePid);
      return pids.some((pid) => pid !== undefined && alive(pid));
    })
    .map((session) => {
      const title = deps.titleOf?.(session);
      return title === undefined ? session : { ...session, title };
    })
    .map((session) => ({ session, doing: doingOf(session, listening.get(session.id), asks) }))
    .sort((a, b) => rank(a.doing) - rank(b.doing) || since(b.doing) - since(a.doing));
  const names = labels(rows.map((row) => row.session));
  return rows.map((row, at) => ({ ...row, name: names[at] ?? "" }));
}

/**
 * The answer to /sessions: one line each, and a button for each session that can take a message now or
 * after its turn (plan 7.4). A stopped one can't: no hook of it waits, so nothing would wake it.
 */
export function sessionList(deps: SessionListDeps): CommandAnswer {
  const all = listed(deps);
  if (all.length === 0) return { text: "No sessions are open." };
  const now = deps.now?.() ?? Date.now();
  const shown = all.slice(0, MOST);
  const count = all.length === 1 ? "1 open session" : `${all.length} open sessions`;
  const lines = [`${count}:`, ...shown.map((row) => lineOf(row, now))];
  if (all.length > shown.length) lines.push(`…and ${all.length - shown.length} more`);
  const buttons: InlineKeyboardButton[][] = shown
    .filter((row) => row.doing.kind !== "idle" && ID.test(row.session.id))
    .map((row) => [
      { text: `${emojiOf(row.doing)} ${row.name}`, callback_data: `write:${row.session.id}` },
    ]);
  if (buttons.length > 0) lines.push("", "Tap one to write to it.");
  if (shown.some((row) => row.doing.kind === "idle")) {
    lines.push("💤 A stopped session takes a message again once it's used at the Mac.");
  }
  const text = lines.join("\n");
  return buttons.length === 0 ? { text } : { text, reply_markup: { inline_keyboard: buttons } };
}

function doingOf(session: Session, waiter: Waiter | undefined, asks: readonly Ask[]): Doing {
  const own = asks.filter((ask) => ask.sessionId === session.id);
  const here = own.find((ask) => ask.state === "remote");
  if (here !== undefined) return { kind: "asks", ask: here };
  if (waiter !== undefined) return { kind: "listening", since: session.stoppedAt };
  const atMac = own.find((ask) => ask.state === "local");
  if (atMac !== undefined) return { kind: "at-mac", ask: atMac };
  if (session.promptedAt > session.stoppedAt) return { kind: "working", since: session.promptedAt };
  return { kind: "idle", since: session.stoppedAt };
}

function rank(doing: Doing): number {
  return ORDER.indexOf(doing.kind);
}

function since(doing: Doing): number {
  return "since" in doing ? doing.since : doing.ask.createdAt;
}

function lineOf({ name, doing }: Listed, now: number): string {
  const ago = (at: number) => duration((now - at) / 1000);
  const start = `${emojiOf(doing)} ${name}`;
  switch (doing.kind) {
    case "asks":
      return `${start}: waits for your answer here`;
    case "listening":
      return doing.since > 0
        ? `${start}: finished ${ago(doing.since)} ago, waits for your reply`
        : `${start}: waits for your reply`;
    case "at-mac":
      return `${start}: ${whatOf(doing.ask)} waits at the Mac`;
    case "working":
      return `${start}: working for ${ago(doing.since)}`;
    case "idle":
      return doing.since > 0 ? `${start}: stopped ${ago(doing.since)} ago` : `${start}: idle`;
  }
}

export function emojiOf(doing: Doing): string {
  switch (doing.kind) {
    case "asks":
      if (doing.ask.input?.permission !== undefined) return "🔐";
      return doing.ask.input?.plan === undefined ? "❓" : "📋";
    case "listening":
      return "✅";
    case "at-mac":
      return "🖥";
    case "working":
      return "⏳";
    case "idle":
      return "💤";
  }
}

/** A question, a plan or a permission prompt. */
export function whatOf(ask: Ask): string {
  if (ask.input?.permission !== undefined) return "a permission prompt";
  return ask.input?.plan === undefined ? "a question" : "a plan";
}
