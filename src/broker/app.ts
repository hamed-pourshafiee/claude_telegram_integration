import type { Config } from "../shared/config.ts";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import type { Secret } from "../shared/secret.ts";
import { TelegramClient } from "../shared/telegram/client.ts";
import { runCommand } from "./commands.ts";
import type { BrokerDb } from "./db.ts";
import { handleUpdate } from "./gate.ts";
import type { Reading } from "./ioreg.ts";
import { Pairing } from "./pairing.ts";
import { Poller } from "./poller.ts";
import { Presence } from "./presence.ts";
import type { Routes } from "./server.ts";

export interface AppDeps {
  readonly token: Secret;
  readonly db: BrokerDb;
  readonly log: Log;
  readonly config: Config;
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
}

/**
 * The broker's parts: the Telegram client, pairing, presence, the gate for updates, the poller and the
 * routes of its socket. The poller runs only once someone is paired or a pairing is pending (plan
 * 2.4); presence looks at the Mac every 5 s from the start (plan 2.6).
 */
export function createApp(deps: AppDeps): App {
  const { token, db, log, signal } = deps;
  const where = deps.apiBase === undefined ? {} : { apiBase: deps.apiBase };
  const telegram = new TelegramClient({ token, log, signal, ...where });
  const pairing = new Pairing(db);
  const read = deps.readPresence === undefined ? {} : { read: deps.readPresence };
  const presence = new Presence({ db, log, signal, limits: deps.config.presence, ...read });
  const command = (name: Parameters<typeof runCommand>[0]) => runCommand(name, presence);
  const handle = (update: Parameters<typeof handleUpdate>[0]) =>
    handleUpdate(update, { telegram, pairing, log, command });
  const botId = Number(token.reveal().split(":")[0]);
  const poller = new Poller({ telegram, db, log, signal, handle, botId });
  const health = healthOf({ token, botId, db, pairing, poller, presence });
  const routes: Routes = {
    health,
    pair: () => {
      const { code, expiresAt } = pairing.start();
      poller.start();
      log("pairing.started", {});
      return { ok: true, code, expiresAt: new Date(expiresAt).toISOString() };
    },
    hook: (event, body) => hookEvent(event, body, log),
  };
  presence.start();
  if (pairing.pairedUser() !== undefined || pairing.pendingUntil() !== undefined) poller.start();
  return { routes, poller, presence };
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

/** Plan 2.3: a hook reached the broker, which logs it. Later steps handle each event. */
function hookEvent(event: string, body: unknown, log: Log) {
  const session = asFields(body)?.session_id;
  if (typeof session !== "string")
    return { status: 400, body: { ok: false, error: "no session_id" } };
  log("hook.event", { hook: event, session });
  return { status: 200, body: { ok: true, pid: process.pid } };
}
