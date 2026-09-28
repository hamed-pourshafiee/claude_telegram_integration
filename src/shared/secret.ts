import { createHash } from "node:crypto";
import { inspect } from "node:util";

const MASK = "[secret]";

/**
 * A secret that never shows up in a log by accident: printing it or turning it into a string or JSON
 * gives "[secret]". Only reveal() returns the value, at the one place that needs it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** The first 16 hex digits of the value's SHA-256: tells two secrets apart without showing either. */
  fingerprint(): string {
    return createHash("sha256").update(this.#value).digest("hex").slice(0, 16);
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
