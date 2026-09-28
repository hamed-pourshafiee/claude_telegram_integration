import { messageOf } from "../shared/errors.ts";
import type { Log, LogFields } from "../shared/log.ts";
import { pause } from "../shared/pause.ts";
import type { BrokerDb } from "./db.ts";
import { type Reading, readPresence, UNKNOWN } from "./ioreg.ts";

/** Set from Telegram (D4): /auto decides from the Mac's signals, /away is always away, /off mutes. */
export type Mode = "auto" | "away" | "off";
const MODES: readonly Mode[] = ["auto", "away", "off"];

/** Flow 3's three states. */
export type State = "active" | "between" | "away";
/** What decided the state. */
export type Because = "away mode" | "locked" | "idle" | "input" | "unknown";

export interface Thresholds {
  readonly activeSeconds: number;
  readonly awaySeconds: number;
}

/** What the bridge knows about you now. */
export interface Snapshot {
  readonly mode: Mode;
  readonly state: State;
  readonly because: Because;
  readonly idleSeconds: number | undefined;
  readonly locked: boolean | undefined;
}

/**
 * Flow 3 and D4: away when the screen is locked or after awaySeconds without input, active under
 * activeSeconds, in between otherwise. An unknown idle time counts as present.
 */
export function stateOf(
  reading: Pick<Reading, "idleSeconds" | "locked">,
  limits: Thresholds,
): { readonly state: State; readonly because: Because } {
  const idle = reading.idleSeconds;
  if (reading.locked === true) return { state: "away", because: "locked" };
  if (idle === undefined) return { state: "active", because: "unknown" };
  if (idle >= limits.awaySeconds) return { state: "away", because: "idle" };
  if (idle >= limits.activeSeconds) return { state: "between", because: "idle" };
  return { state: "active", because: "input" };
}

export interface PresenceDeps {
  readonly db: BrokerDb;
  readonly log: Log;
  readonly limits: Thresholds;
  /** Ends the sampling, for example when the broker stops. */
  readonly signal: AbortSignal;
  /** Looks at the Mac; tests pass a stand-in. */
  readonly read?: () => Promise<Reading>;
  /** Time between looks; default 5 s (plan 2.6). */
  readonly intervalMs?: number;
}

const MODE_KEY = "presence.mode";

/**
 * Presence (D4, flow 3). It looks at the idle time and the screen lock every 5 s and keeps the latest
 * look; the mode set from Telegram is stored, so it outlives a restart. Changes of state or of its
 * reason (away since the screen locked, say), and of what can't be read, are logged.
 */
export class Presence {
  readonly #deps: PresenceDeps;
  #reading: Reading = UNKNOWN;
  /** The state and reason last logged, such as "away/locked". */
  #logged = "";
  #problems = "";
  #running = false;

  constructor(deps: PresenceDeps) {
    this.#deps = deps;
  }

  get limits(): Thresholds {
    return this.#deps.limits;
  }

  get running(): boolean {
    return this.#running;
  }

  get mode(): Mode {
    const stored = this.#deps.db.getMeta(MODE_KEY);
    return MODES.find((mode) => mode === stored) ?? "auto";
  }

  setMode(mode: Mode): void {
    this.#deps.db.setMeta(MODE_KEY, mode);
    this.#deps.log("presence.mode", { mode });
  }

  snapshot(): Snapshot {
    const mode = this.mode;
    const { idleSeconds, locked } = this.#reading;
    const { state, because } =
      mode === "away"
        ? { state: "away" as const, because: "away mode" as const }
        : stateOf(this.#reading, this.#deps.limits);
    return { mode, state, because, idleSeconds, locked };
  }

  start(): void {
    if (this.#running || this.#deps.signal.aborted) return;
    this.#running = true;
    void this.#loop()
      .catch((error: unknown) => this.#deps.log("presence.crashed", { error: messageOf(error) }))
      .finally(() => {
        this.#running = false;
      });
  }

  /** One look: keeps it, and logs what changed. */
  async sample(): Promise<void> {
    let reading: Reading;
    try {
      reading = await (this.#deps.read ?? readPresence)();
    } catch (error) {
      reading = { ...UNKNOWN, problems: [`the look failed: ${messageOf(error)}`] };
    }
    this.#reading = reading;
    this.#logChanges(reading);
  }

  async #loop(): Promise<void> {
    const { signal } = this.#deps;
    while (!signal.aborted) {
      await this.sample();
      await pause(this.#deps.intervalMs ?? 5000, signal);
    }
  }

  #logChanges(reading: Reading): void {
    const problems = reading.problems.join("; ");
    if (problems !== this.#problems) {
      if (problems) this.#deps.log("presence.unreadable", { problems });
      else this.#deps.log("presence.readable", {});
      this.#problems = problems;
    }
    const { state, because } = stateOf(reading, this.#deps.limits);
    if (`${state}/${because}` === this.#logged) return;
    this.#logged = `${state}/${because}`;
    const idle: LogFields =
      reading.idleSeconds === undefined ? {} : { idleSeconds: Math.floor(reading.idleSeconds) };
    this.#deps.log("presence.changed", { state, because, ...idle });
  }
}
