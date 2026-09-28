import { randomBytes } from "node:crypto";

const KEEP_MS = 24 * 60 * 60_000;
const MAX_KEPT = 100;

export interface FullText {
  /** Already redacted (D8). */
  readonly text: string;
  readonly filename: string;
}

/**
 * The full replies behind 📄 buttons (D8). They stay in memory only, for a day and at most the newest
 * MAX_KEPT, so none of Claude's text is written to disk; a restarted broker has none.
 */
export class FullTexts {
  readonly #kept = new Map<string, FullText & { readonly until: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Keeps `text`; the id returned goes in the button's callback data. */
  put(text: string, filename: string): string {
    const id = randomBytes(8).toString("hex");
    this.#kept.set(id, { text, filename, until: this.#now() + KEEP_MS });
    // A Map keeps insertion order, so the oldest go first.
    for (const old of this.#kept.keys()) {
      if (this.#kept.size <= MAX_KEPT) break;
      this.#kept.delete(old);
    }
    return id;
  }

  get(id: string): FullText | undefined {
    const kept = this.#kept.get(id);
    if (kept === undefined || kept.until <= this.#now()) {
      this.#kept.delete(id);
      return undefined;
    }
    return { text: kept.text, filename: kept.filename };
  }
}
