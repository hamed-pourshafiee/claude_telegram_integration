import type { Config } from "../shared/config.ts";
import type { Log } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import type { Secret } from "../shared/secret.ts";
import { TelegramClient } from "../shared/telegram/client.ts";
import type { Update } from "../shared/telegram/types.ts";
import { runCommand } from "./commands.ts";
import type { BrokerDb } from "./db.ts";
import { FullTexts } from "./full-texts.ts";
import { type GateDeps, handleUpdate, replyOf } from "./gate.ts";
import { firstName, HookEvents } from "./hook-events.ts";
import { Inbox } from "./inbox.ts";
import type { Reading } from "./ioreg.ts";
import { Notifier } from "./notifier.ts";
import { Pairing } from "./pairing.ts";
import { Poller } from "./poller.ts";
import { Presence } from "./presence.ts";
import { Relay } from "./relay.ts";
import type { Routes } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { Waiters } from "./waiters.ts";

export interface AppDeps {
  readonly token: Secret;
  readonly db: BrokerDb;
  readonly log: Log;
  readonly config: Config;
  /** Where hooks leave cancels and ends while no broker runs (plan 3.1). */
  readonly paths: StatePaths;
  /** Aborted when the broker stops: it ends the poller, presence and any Telegram call. */
  readonly signal: AbortSignal;
  /** Tests point the Telegram client at a local fake… */
  readonly apiBase?: string;
  /** …and look at a stand-in Mac. */
  readonly readPresence?: () => Promise<Reading>;
}

export interface App {
  readonly routes: Routes;
  readonly poller: Poller;
  readonly presence: Presence;
  readonly relay: Relay;
}

/**
 * The broker's parts: the Telegram client, pairing, presence, the notifier, the relay for replies, the
 * gate for updates, the poller and the routes of its socket. The poller runs only once someone is paired
 * or a pairing is pending (plan 2.4), and only after the relay has recovered what a crash or a stopped
 * broker left (plan 3.1); presence looks at the Mac every 5 s from the start (plan 2.6); hooks' calls
 * go to HookEvents (plan 2.7).
 */
export function createApp(deps: AppDeps): App {
  const { token, db, log, signal, config } = deps;
  const where = deps.apiBase === undefined ? {} : { apiBase: deps.apiBase };
  const telegram = new TelegramClient({ token, log, signal, ...where });
  const pairing = new Pairing(db);
  const read = deps.readPresence === undefined ? {} : { read: deps.readPresence };
  const presence = new Presence({ db, log, signal, limits: config.presence, ...read });
  const fullTexts = new FullTexts();
  const notifier = new Notifier({ telegram, pairing, presence, config, log, fullTexts });
  const sessions = new Sessions(db);
  const relay = relayOf(db, sessions, telegram, pairing, log);
  const hookEvents = new HookEvents({ sessions, notifier, pairing, relay, log });
  const gate: GateDeps = {
    telegram,
    pairing,
    log,
    command: (name) => runCommand(name, presence),
    press: (data, chat, queryId) => notifier.press(data, chat, queryId),
    reply: (updateId) => relay.route(updateId),
  };
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
  relay.recover(deps.paths);
  if (pairing.pairedUser() !== undefined || pairing.pendingUntil() !== undefined) poller.start();
  return { routes, poller, presence, relay };
}

/** The relay, which tells the paired user about their replies in their chat with the bot. */
function relayOf(
  db: BrokerDb,
  sessions: Sessions,
  telegram: TelegramClient,
  pairing: Pairing,
  log: Log,
): Relay {
  const tell = async (text: string) => {
    const user = pairing.pairedUser();
    if (user !== undefined) await telegram.sendMessage({ chat_id: user.id, text });
  };
  const senderName = () => firstName(pairing.pairedUser()?.name);
  const waiters = new Waiters(db);
  const inbox = new Inbox(db);
  return new Relay({ db, sessions, waiters, inbox, tell, senderName, log });
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
