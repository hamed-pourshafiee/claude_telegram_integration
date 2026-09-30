import type { Config } from "../shared/config.ts";
import { messageOf } from "../shared/errors.ts";
import { type Log, noLog } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { contentModeFor } from "../shared/scope.ts";
import type { Secret } from "../shared/secret.ts";
import { TelegramClient } from "../shared/telegram/client.ts";
import type { Update } from "../shared/telegram/types.ts";
import { askParts, replyParts } from "./app-parts.ts";
import type { AskChat } from "./ask-chat.ts";
import type { AskRelay } from "./ask-relay.ts";
import { type CommandAnswer, MENU, runCommand } from "./commands.ts";
import type { BrokerDb } from "./db.ts";
import { FullTexts } from "./full-texts.ts";
import { type GateDeps, handleUpdate, replyOf } from "./gate.ts";
import { HookEvents, type HookEventsDeps } from "./hook-events.ts";
import type { Reading } from "./ioreg.ts";
import type { NewSessions } from "./new-session.ts";
import { Notifier } from "./notifier.ts";
import { Outbox } from "./outbox.ts";
import { Pairing } from "./pairing.ts";
import { Poller } from "./poller.ts";
import { Presence } from "./presence.ts";
import type { Relay } from "./relay.ts";
import type { Router } from "./router.ts";
import type { Routes } from "./server.ts";
import type { Launch } from "./session-launch.ts";
import { type Session, Sessions } from "./sessions.ts";
import { sessionsParts } from "./sessions-command.ts";
import type { VsWindow } from "./vscode-windows.ts";

export interface AppDeps {
  readonly token: Secret;
  readonly db: BrokerDb;
  readonly log: Log;
  /** Every step of a permission prompt relayed to Telegram (D9). */
  readonly audit?: Log;
  readonly config: Config;
  /** Where hooks leave cancels and ends while no broker runs (plan 3.1). */
  readonly paths: StatePaths;
  /** Aborted when the broker stops: it ends the poller, presence and any Telegram call. */
  readonly signal: AbortSignal;
  /** Tests point the Telegram client at a local fake… */
  readonly apiBase?: string;
  /** …and look at a stand-in Mac… */
  readonly readPresence?: () => Promise<Reading>;
  /** …and start a stand-in for the sessions /new starts, in stand-in VS Code windows (plan 7.7). */
  readonly launchSession?: Launch;
  readonly openWindows?: () => readonly VsWindow[];
}

export interface App {
  readonly routes: Routes;
  readonly poller: Poller;
  readonly presence: Presence;
  readonly relay: Relay;
  readonly asks: AskRelay;
}

/**
 * The broker's parts: the Telegram client, pairing, presence, the notifier, the relays for replies and
 * for Claude's questions, the gate for updates, the poller and the routes of its socket. The poller runs
 * only once someone is paired or a pairing is pending (plan 2.4), and only after the relays have
 * recovered what a crash or a stopped broker left (plans 3.1, 4.1); presence looks at the Mac every 5 s
 * from the start (plan 2.6); hooks' calls go to HookEvents (plan 2.7).
 */
export function createApp(deps: AppDeps): App {
  const { token, db, log, signal, config } = deps;
  const where = deps.apiBase === undefined ? {} : { apiBase: deps.apiBase };
  const telegram = new TelegramClient({ token, log, signal, ...where });
  const pairing = new Pairing(db);
  const read = deps.readPresence === undefined ? {} : { read: deps.readPresence };
  const presence = new Presence({ db, log, signal, limits: config.presence, ...read });
  const fullTexts = new FullTexts();
  const sessions = new Sessions(db);
  const outbox = new Outbox(db);
  outbox.prune();
  const link = (chat: number, messageId: number, session: Session, kind: string) =>
    outbox.link(chat, messageId, { sessionId: session.id, generation: session.generation, kind });
  const notifier = new Notifier({ telegram, pairing, presence, config, log, fullTexts, link });
  const audit = deps.audit ?? noLog;
  const ask = askParts({ db, sessions, telegram, pairing, presence, config, log, audit, notifier });
  const parts = { db, sessions, telegram, pairing, log, outbox, notifier, asks: ask.chat };
  const { relay, router, waiters, fresh } = replyParts(parts, deps);
  const hookEvents = hookEventsOf(
    { sessions, notifier, pairing, relay, asks: ask.relay, log },
    config,
  );
  const listing = sessionsParts(
    { sessions, waiters, asks: ask.asks, telegram, outbox, log },
    config,
  );
  const gateParts = { telegram, pairing, log, presence, notifier, router, asks: ask.chat, fresh };
  const gate = gateOf({ ...gateParts, ...listing });
  const botId = Number(token.reveal().split(":")[0]);
  const handle = (update: Update) => handleUpdate(update, gate);
  const accept = (update: Update) => {
    const reply = replyOf(update, pairing.pairedUser()?.id);
    if (reply !== undefined) relay.accept(reply);
  };
  const poller = new Poller({ telegram, db, log, signal, accept, handle, botId });
  const routes: Routes = {
    health: healthOf({ token, botId, db, pairing, poller, presence }),
    pair: () => startPairing(pairing, poller, log),
    hook: (event, body) => hookEvents.handle(event, body),
  };
  presence.start();
  // What a crash or a stopped broker left, before any new reply: the relays' part, then the router's,
  // whose decisions are all made before recover() first waits.
  relay.recover(deps.paths);
  ask.relay.recover();
  router
    .recover()
    .catch((error: unknown) => log("router.recover-failed", { error: String(error) }));
  const paired = pairing.pairedUser();
  if (paired !== undefined) setMenu(telegram, paired.id, log);
  if (paired !== undefined || pairing.pendingUntil() !== undefined) poller.start();
  return { routes, poller, presence, relay, asks: ask.relay };
}

/**
 * The hooks' calls. Messages name a session by its title only where Claude's text may leave the Mac
 * (D8, plan 7.2), so titles kept for a folder that config.json has since made ping-only go.
 */
function hookEventsOf(deps: Omit<HookEventsDeps, "showsText">, config: Config): HookEvents {
  const showsText = (projectDir: string) => contentModeFor(config, projectDir) === "full";
  deps.sessions.forgetTitles(showsText);
  return new HookEvents({ ...deps, showsText });
}

interface GateParts {
  readonly telegram: TelegramClient;
  readonly pairing: Pairing;
  readonly log: Log;
  readonly presence: Presence;
  readonly notifier: Notifier;
  readonly router: Router;
  readonly asks: AskChat;
  /** The answer to /sessions (plan 7.3)… */
  readonly list: () => CommandAnswer;
  /** …and a tap on one of its sessions (plan 7.4). */
  readonly write: (data: string, chat: number, queryId: string) => Promise<void>;
  /** /new and its folder buttons (plan 7.7). */
  readonly fresh: NewSessions;
}

/** What the gate does with the paired user's commands, buttons and replies. */
function gateOf(parts: GateParts): GateDeps {
  const { telegram, pairing, log, presence, notifier, router, asks, list, write, fresh } = parts;
  return {
    telegram,
    pairing,
    log,
    command: (name) => {
      if (name === "local") return asks.handBack();
      if (name === "sessions") return list();
      if (name === "new") return fresh.answer();
      return runCommand(name, presence);
    },
    press: (data, chat, queryId) => {
      if (data.startsWith("full:")) return notifier.press(data, chat, queryId);
      if (data.startsWith("ask:")) return asks.press(data, queryId);
      if (data.startsWith("write:")) return write(data, chat, queryId);
      if (data.startsWith("new:")) return fresh.press(data, chat, queryId);
      return router.press(data, queryId);
    },
    reply: (updateId) => router.route(updateId),
    paired: (chat) => setMenu(telegram, chat, log),
  };
}

/**
 * The paired chat's menu of commands (plan 7.1), set at every start and on pairing; other chats get
 * none. A failure is only logged: the next start tries again.
 */
function setMenu(telegram: TelegramClient, chat: number, log: Log): void {
  telegram
    .setMyCommands({ commands: MENU, scope: { type: "chat", chat_id: chat } })
    .then(() => log("menu.set", {}))
    .catch((error: unknown) => log("menu.failed", { error: messageOf(error) }));
}

/** `ctl pair` (plan 2.4): a new code, and polling from now on to hear it. */
function startPairing(pairing: Pairing, poller: Poller, log: Log) {
  const { code, expiresAt } = pairing.start();
  poller.start();
  log("pairing.started", {});
  return { ok: true, code, expiresAt: new Date(expiresAt).toISOString() };
}

interface Parts {
  readonly token: Secret;
  readonly botId: number;
  readonly db: BrokerDb;
  readonly pairing: Pairing;
  readonly poller: Poller;
  readonly presence: Presence;
}

function healthOf({ token, botId, db, pairing, poller, presence }: Parts): () => unknown {
  const startedAt = new Date();
  const tokenFingerprint = token.fingerprint();
  return () => {
    const pendingUntil = pairing.pendingUntil();
    const { mode, state, because, idleSeconds, locked } = presence.snapshot();
    return {
      ok: true,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      botId,
      tokenFingerprint,
      schema: db.schemaVersion,
      envKeys: Object.keys(process.env).sort(),
      paired: pairing.pairedUser()?.name ?? null,
      pairingUntil: pendingUntil === undefined ? null : new Date(pendingUntil).toISOString(),
      polling: poller.running,
      presence: { mode, state, because, idleSeconds: idleSeconds ?? null, locked: locked ?? null },
    };
  };
}
