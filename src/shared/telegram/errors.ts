import { ConfigError } from "../errors.ts";
import { asFields } from "./types.ts";

export type TelegramErrorKind =
  | "api"
  | "flood"
  | "network"
  | "timeout"
  | "cancelled"
  | "bad-answer";

/**
 * A Bot API call that failed. Its message and fields come from safe parts only (the method, the HTTP
 * status, Telegram's error code and description), never from the URL, so it can't carry the token.
 */
export class TelegramError extends Error {
  override name = "TelegramError";
  readonly method: string;
  readonly kind: TelegramErrorKind;
  /** Telegram's error_code, or the HTTP status of an unexpected answer. */
  readonly code: number | undefined;
  /** Seconds to wait, from a 429 answer. */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    method: string,
    kind: TelegramErrorKind,
    code?: number,
    retryAfter?: number,
  ) {
    super(message);
    this.method = method;
    this.kind = kind;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * BUN_CONFIG_VERBOSE_FETCH makes Bun print the URL of every request, and Bot API URLs carry the token.
 * Unsetting it after Bun has started doesn't turn it off, and setting it at runtime turns it on
 * (tested with Bun 1.4.1), so refuse to run instead (D3).
 */
export function refuseVerboseFetch(env: Readonly<Record<string, string | undefined>>): void {
  const value = env.BUN_CONFIG_VERBOSE_FETCH?.trim().toLowerCase();
  if (value !== undefined && value !== "" && value !== "0" && value !== "false") {
    throw new ConfigError(
      "BUN_CONFIG_VERBOSE_FETCH is set, so Bun would print the bot token with every request. " +
        "Unset it and run again.",
    );
  }
}

/** The error's code, such as ConnectionRefused, when it looks like one; otherwise its name. */
export function errorCode(error: unknown): string {
  const code = asFields(error)?.code;
  if (typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown";
}
