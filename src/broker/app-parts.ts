import type { Config } from "../shared/config.ts";
import { type Log, noLog } from "../shared/log.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import type { AppDeps } from "./app.ts";
import { askWhere } from "./ask-calls.ts";
import { AskChat } from "./ask-chat.ts";
import { AskMessages } from "./ask-messages.ts";
import { AskRelay } from "./ask-relay.ts";
import { type Ask, Asks } from "./asks.ts";
import type { BrokerDb } from "./db.ts";
import { firstName } from "./hook-events.ts";
import { Inbox } from "./inbox.ts";
import { NewSessions } from "./new-session.ts";
import type { Notifier } from "./notifier.ts";
import type { Outbox } from "./outbox.ts";
import type { Pairing } from "./pairing.ts";
import type { Presence } from "./presence.ts";
import { Relay } from "./relay.ts";
import { Router } from "./router.ts";
import { launchSession, loginShell } from "./session-launch.ts";
import type { Sessions } from "./sessions.ts";
import { type Start, Starts } from "./starts.ts";
import { openTab } from "./vscode-tab.ts";
import { openWindows } from "./vscode-windows.ts";
import { type Waiter, Waiters } from "./waiters.ts";

// The broker's parts for Claude's questions and for your replies, which createApp() puts together.

interface AskParts {
  readonly db: BrokerDb;
  readonly sessions: Sessions;
  readonly telegram: TelegramClient;
  readonly pairing: Pairing;
  readonly presence: Presence;
  readonly config: Config;
  readonly log: Log;
  readonly audit: Log;
  readonly notifier: Notifier;
}

/**
 * The parts for Claude's questions (plan 4.1): their hooks' side, their messages, and your side, which
 * hears of every change of presence (flow 3).
 */
export function askParts(parts: AskParts) {
  const { db, sessions, telegram, pairing, presence, config, log, audit, notifier } = parts;
  const asks = new Asks(db);
  const messages = new AskMessages({ asks, notifier, telegram, log });
  const where = askWhere({ pairing, presence, config });
  const onLocal = (ask: Ask) => chat.localNow(ask);
  const relay = new AskRelay({ sessions, asks, messages, where, presence, log, onLocal, audit });
  const chat = new AskChat({ asks, relay, messages, sessions, presence, telegram, log, audit });
  presence.watch((now, before) => chat.presenceChanged(now, before));
  return { relay, chat, asks };
}

interface ReplyParts {
  readonly db: BrokerDb;
  readonly sessions: Sessions;
  readonly telegram: TelegramClient;
  readonly pairing: Pairing;
  readonly log: Log;
  readonly outbox: Outbox;
  readonly notifier: Notifier;
  readonly asks: AskChat;
}

/**
 * The parts that take replies to sessions (plans 3.1 to 3.3), and /new, which a reply to its question
 * starts (plan 7.7). Messages about your replies go to the paired user; a wait that typing at the Mac
 * cancelled has its ✅ edited to say so.
 */
export function replyParts(parts: ReplyParts, deps: AppDeps) {
  const { db, sessions, telegram, pairing, log, outbox, notifier, asks } = parts;
  const tell = async (text: string) => {
    const user = pairing.pairedUser();
    if (user !== undefined) await telegram.sendMessage({ chat_id: user.id, text });
  };
  const senderName = () => firstName(pairing.pairedUser()?.name);
  const onCancelled = (waiter: Waiter) => {
    notifier.continuedAtMac(waiter.sessionId, waiter.generation).catch((error: unknown) => {
      log("notice.continued-failed", { session: waiter.sessionId, error: String(error) });
    });
  };
  const waiters = new Waiters(db);
  const inbox = new Inbox(db);
  const relay = new Relay({ db, sessions, waiters, inbox, tell, senderName, log, onCancelled });
  const { starts, fresh } = newParts({ db, sessions, telegram, senderName, tell, log }, deps);
  const start = (text: string, begun: Start) => fresh.start(text, begun);
  const routing = { relay, waiters, asks, inbox, outbox, sessions, telegram, log, starts, start };
  return { relay, router: new Router(routing), waiters, fresh };
}

interface NewParts {
  readonly db: BrokerDb;
  readonly sessions: Sessions;
  readonly telegram: TelegramClient;
  readonly senderName: () => string | null;
  readonly tell: (text: string) => Promise<void>;
  readonly log: Log;
}

/**
 * /new (plans 7.7 and 7.8): the questions it asks, the tabs a reply to one opens, and the sessions it
 * runs in the background when no tab starts.
 */
function newParts(parts: NewParts, deps: AppDeps) {
  const starts = new Starts(parts.db);
  starts.prune();
  const launch = deps.launchSession ?? launchSession(deps.paths.logs, loginShell());
  const audit = deps.audit ?? noLog;
  const windows = deps.openWindows ?? (() => openWindows(parts.log));
  const tab = deps.openTab ?? openTab();
  const config = deps.config;
  const fresh = new NewSessions({ ...parts, starts, config, windows, openTab: tab, launch, audit });
  return { starts, fresh };
}
