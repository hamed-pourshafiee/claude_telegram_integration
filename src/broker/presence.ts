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
  /** …and while hurried in between; default 1 s (plan 4.1). */
  readonly fastMs?: number;
}

/**
 * Told when the state changes, the mode's part included: the state now, and the one before, which is
 * undefined for the first look.
 */
export type PresenceListener = (now: Snapshot, before: State | undefined) => void;

export const MODE_KEY = "presence.mode";

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
  readonly #listeners: PresenceListener[] = [];
  /** The state the listeners last heard of. */
  #told: State | undefined;
  #hurried = false;
  /** Ends the current pause between looks. */
  #wake = new AbortController();

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
    this.#tell();
  }

  /** Calls `listener` whenever the state changes, by a look at the Mac or by a mode (flow 3). */
  watch(listener: PresenceListener): void {
    this.#listeners.push(listener);
  }

  /**
   * While a question waits on Telegram (plan 4.1): in between, the Mac is looked at every second, so
   * that your first touch hands it to the local dialog at once. Away, 5 s is soon enough, and cheaper.
   */
  hurry(on: boolean): void {
    if (on === this.#hurried) return;
    this.#hurried = on;
    if (on) this.#wake.abort();
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
    this.#tell();
  }

  async #loop(): Promise<void> {
    const { signal } = this.#deps;
    while (!signal.aborted) {
      await this.sample();
      this.#wake = new AbortController();
      const fast = this.#hurried && this.snapshot().state === "between";
      const wait = fast ? (this.#deps.fastMs ?? 1000) : (this.#deps.intervalMs ?? 5000);
      await pause(wait, AbortSignal.any([signal, this.#wake.signal]));
    }
  }

  /**
   * Tells the listeners of a new state, and of the first look: a broker that restarts with a question
   * waiting in the chat while you're at the Mac must hand it over then, not at your next change.
   */
  #tell(): void {
    const now = this.snapshot();
    const before = this.#told;
    this.#told = now.state;
    if (before === now.state) return;
    for (const listener of this.#listeners) {
      try {
        listener(now, before);
      } catch (error) {
        this.#deps.log("presence.listener-failed", { error: messageOf(error) });
      }
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
