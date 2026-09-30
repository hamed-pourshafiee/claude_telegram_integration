import { processAlive } from "../shared/process.ts";
import type { Ask, Asks } from "./asks.ts";
import { duration } from "./commands.ts";
import { labels, type Session, type Sessions } from "./sessions.ts";
import type { Waiter, Waiters } from "./waiters.ts";

export interface SessionListDeps {
  readonly sessions: Pick<Sessions, "open">;
  readonly waiters: Pick<Waiters, "listening">;
  readonly asks: Pick<Asks, "inState">;
  /** Whether a process runs; default: a signal-0 kill. */
  readonly alive?: (pid: number) => boolean;
  readonly now?: () => number;
}

/** What a session is doing, in the order the list shows them: what needs you first. */
type Doing =
  | { readonly kind: "asks"; readonly ask: Ask }
  | { readonly kind: "listening"; readonly since: number }
  | { readonly kind: "at-mac"; readonly ask: Ask }
  | { readonly kind: "working"; readonly since: number }
  | { readonly kind: "idle"; readonly since: number };

const ORDER: readonly Doing["kind"][] = ["asks", "listening", "at-mac", "working", "idle"];
/** The most sessions one message lists. */
const MOST = 30;

/**
 * The answer to /sessions (plan 7.3): the sessions that are open, one line each, with what each is
 * doing. A session counts as open until its SessionEnd, which a crash never sends, so only those whose
 * Claude still runs are listed (F18): the session's own, or that of a hook waiting for you.
 */
export function sessionList(deps: SessionListDeps): string {
  const alive = deps.alive ?? processAlive;
  const now = deps.now?.() ?? Date.now();
  const listening = new Map(deps.waiters.listening().map((waiter) => [waiter.sessionId, waiter]));
  const asks = deps.asks.inState(["remote", "local"]);
  const running = deps.sessions.open().filter((session) => {
    const pids = [session.claudePid, listening.get(session.id)?.claudePid];
    for (const ask of asks) if (ask.sessionId === session.id) pids.push(ask.claudePid);
    return pids.some((pid) => pid !== undefined && alive(pid));
  });
  if (running.length === 0) return "No sessions are open.";
  const rows = running
    .map((session) => ({ session, doing: doingOf(session, listening.get(session.id), asks) }))
    .sort((a, b) => rank(a.doing) - rank(b.doing) || since(b.doing) - since(a.doing));
  const shown = rows.slice(0, MOST);
  const names = labels(shown.map((row) => row.session));
  const lines = shown.map((row, at) => lineOf(names[at] ?? "", row.doing, now));
  const more = rows.length - shown.length;
  const count = running.length === 1 ? "1 open session" : `${running.length} open sessions`;
  return [`${count}:`, ...lines, ...(more > 0 ? [`…and ${more} more`] : [])].join("\n");
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

function lineOf(name: string, doing: Doing, now: number): string {
  const ago = (at: number) => duration((now - at) / 1000);
  switch (doing.kind) {
    case "asks":
      return `${emojiOf(doing.ask)} ${name}: waits for your answer here`;
    case "listening":
      return doing.since > 0
        ? `✅ ${name}: finished ${ago(doing.since)} ago, waits for your reply`
        : `✅ ${name}: waits for your reply`;
    case "at-mac":
      return `🖥 ${name}: ${whatOf(doing.ask)} waits at the Mac`;
    case "working":
      return `⏳ ${name}: working for ${ago(doing.since)}`;
    case "idle":
      return doing.since > 0 ? `💤 ${name}: stopped ${ago(doing.since)} ago` : `💤 ${name}: idle`;
  }
}

function emojiOf(ask: Ask): string {
  if (ask.input?.permission !== undefined) return "🔐";
  return ask.input?.plan === undefined ? "❓" : "📋";
}

function whatOf(ask: Ask): string {
  if (ask.input?.permission !== undefined) return "a permission prompt";
  return ask.input?.plan === undefined ? "a question" : "a plan";
}
