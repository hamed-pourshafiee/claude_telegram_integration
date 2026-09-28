import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import { pause } from "../shared/pause.ts";
import type { TelegramClient } from "../shared/telegram/client.ts";
import { TelegramError } from "../shared/telegram/errors.ts";
import type { Update } from "../shared/telegram/types.ts";
import type { BrokerDb } from "./db.ts";

export interface PollerDeps {
  readonly telegram: Pick<TelegramClient, "getUpdates">;
  readonly db: BrokerDb;
  readonly log: Log;
  readonly handle: (update: Update) => Promise<void>;
  /** Whose updates these are: offsets are kept per bot, so another bot in .env starts afresh. */
  readonly botId: number;
  /** Ends the loop, for example when the broker stops. */
  readonly signal: AbortSignal;
  /** Seconds each getUpdates waits for news (long polling); default 50. */
  readonly pollSeconds?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The meta key of a bot's offset. A token replaced in BotFather keeps its bot id, and its offset. */
export function offsetKey(botId: number): string {
  return `telegram.offset.${botId}`;
}

/**
 * The only Telegram poller (F8). It long-polls getUpdates, hands each update to `handle`, and records
 * the offset after each one, so a restart carries on after the last update handled. A crash between
 * handling an update and recording it would hand that one update over again; plan 3.2's inbox, which
 * stores each update before handling it, makes delivery at-most-once (D7). A failure waits before the
 * next try: 1 s, doubling up to 60 s; 60 s after a 409 (another poller on this token); 5 minutes after
 * a 401 (a revoked token).
 */
export class Poller {
  readonly #deps: PollerDeps;
  #running = false;

  constructor(deps: PollerDeps) {
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running || this.#deps.signal.aborted) return;
    this.#running = true;
    this.#deps.log("poll.started", {});
    void this.#loop()
      .catch((error: unknown) => this.#deps.log("poll.crashed", { error: messageOf(error) }))
      .finally(() => {
        this.#running = false;
      });
  }

  async #loop(): Promise<void> {
    const { telegram, db, log, signal } = this.#deps;
    const sleep = this.#deps.sleep ?? pause;
    let failures = 0;
    while (!signal.aborted) {
      const offset = Number(db.getMeta(offsetKey(this.#deps.botId)) ?? "0");
      try {
        const timeout = this.#deps.pollSeconds ?? 50;
        const updates = await telegram.getUpdates(offset > 0 ? { offset, timeout } : { timeout });
        failures = 0;
        for (const update of updates) await this.#one(update);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        const waitMs = backoffMs(error, failures);
        const kind = error instanceof TelegramError ? error.kind : "error";
        const code = error instanceof TelegramError ? (error.code ?? 0) : 0;
        log("poll.failed", { kind, code, waitMs });
        await sleep(waitMs, signal);
      }
    }
  }

  async #one(update: Update): Promise<void> {
    try {
      await this.#deps.handle(update);
    } catch (error) {
      this.#deps.log("update.failed", { update: update.update_id, error: messageOf(error) });
    }
    this.#deps.db.setMeta(offsetKey(this.#deps.botId), String(update.update_id + 1));
  }
}

/** How long to wait after the `failures`-th failure in a row. */
export function backoffMs(error: unknown, failures: number): number {
  if (error instanceof TelegramError) {
    if (error.code === 401) return 5 * 60_000;
    if (error.code === 409) return 60_000;
    if (error.kind === "flood" && error.retryAfter !== undefined) return error.retryAfter * 1000;
  }
  return Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
}
