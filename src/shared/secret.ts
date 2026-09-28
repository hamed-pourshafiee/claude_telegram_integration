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
