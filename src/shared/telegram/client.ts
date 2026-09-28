import { errorCode } from "../errors.ts";
import { type Log, noLog } from "../log.ts";
import type { Secret } from "../secret.ts";
import { refuseVerboseFetch, TelegramError, type TelegramErrorKind } from "./errors.ts";
import {
  type Answer,
  type AnswerCallbackQueryParams,
  type EditMessageTextParams,
  type GetUpdatesParams,
  type Message,
  parseAnswer,
  parseMessage,
  parseUpdate,
  parseUser,
  type SendDocumentParams,
  type SendMessageParams,
  type Update,
  type User,
} from "./types.ts";

const BOT_API = "https://api.telegram.org";

type Sleep = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

export interface TelegramOptions {
  readonly token: Secret;
  /** The Bot API's address. Only tests change it, to a local fake; never read from the environment. */
  readonly apiBase?: string;
  readonly log?: Log;
  /** Waits before a retry, ending early if `signal` aborts; tests replace it so they don't wait. */
  readonly sleep?: Sleep;
  /** How many 429 answers one call retries (default 3). */
  readonly maxRetries?: number;
  /** A longer retry_after fails the call with kind "flood" instead of waiting (default 60 s). */
  readonly maxRetryAfterSeconds?: number;
  /** Per request (default 30 s); getUpdates gets its long-poll timeout plus 10 s. */
  readonly timeoutMs?: number;
  /** Cancels every request, for example when the broker stops. */
  readonly signal?: AbortSignal;
}

/** A JSON string, or a form for a file upload. */
type RequestBody = string | FormData;

/**
 * The Bot API calls the bridge needs, over fetch (D2). A 429 answer is retried after its retry_after.
 * The token is part of every URL, so no error or log line made here contains a URL, and a description
 * that quotes one has the token masked.
 */
export class TelegramClient {
  readonly #token: Secret;
  readonly #apiBase: string;
  readonly #log: Log;
  readonly #sleep: Sleep;
  readonly #maxRetries: number;
  readonly #maxRetryAfter: number;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(options: TelegramOptions) {
    refuseVerboseFetch(process.env);
    this.#token = options.token;
    this.#apiBase = options.apiBase ?? BOT_API;
    this.#log = options.log ?? noLog;
    this.#sleep = options.sleep ?? pause;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxRetryAfter = options.maxRetryAfterSeconds ?? 60;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#signal = options.signal;
  }

  async getMe(): Promise<User> {
    return this.#shaped(parseUser(await this.#call("getMe", json({}))), "getMe");
  }

  /** New messages and button presses; malformed ones come back as kind "other". */
  async getUpdates(params: GetUpdatesParams = {}): Promise<Update[]> {
    const body = json({ ...params, allowed_updates: ["message", "callback_query"] });
    const result = await this.#call("getUpdates", body, (params.timeout ?? 0) * 1000 + 10_000);
    if (!Array.isArray(result)) throw this.#badAnswer("getUpdates");
    const items: readonly unknown[] = result;
    const updates = items.map(parseUpdate).filter((update) => update !== undefined);
    if (updates.length < items.length) {
      this.#log("telegram.dropped", { method: "getUpdates", count: items.length - updates.length });
    }
    return updates;
  }

  sendMessage(params: SendMessageParams): Promise<Message> {
    return this.#message("sendMessage", json(params));
  }

  /** Edits one of the bot's messages in a chat. */
  editMessageText(params: EditMessageTextParams): Promise<Message> {
    return this.#message("editMessageText", json(params));
  }

  async answerCallbackQuery(params: AnswerCallbackQueryParams): Promise<void> {
    const result = await this.#call("answerCallbackQuery", json(params));
    if (result !== true) throw this.#badAnswer("answerCallbackQuery");
  }

  sendDocument(params: SendDocumentParams): Promise<Message> {
    const { chat_id, filename, content, ...rest } = params;
    const form = () => {
      const data = new FormData();
      data.set("chat_id", String(chat_id));
      data.set("document", new File([content], filename, { type: "text/markdown" }));
      for (const [key, value] of Object.entries(rest)) {
        data.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      return data;
    };
    return this.#message("sendDocument", form, this.#timeoutMs * 2);
  }

  async #message(method: string, body: () => RequestBody, timeoutMs?: number): Promise<Message> {
    return this.#shaped(parseMessage(await this.#call(method, body, timeoutMs)), method);
  }

  /** One call, retried after each 429 while retry_after and the number of retries stay in bounds. */
  async #call(
    method: string,
    body: () => RequestBody,
    timeoutMs = this.#timeoutMs,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.#request(method, body(), timeoutMs);
      if (answer.ok) return answer.result;
      const wait = answer.retryAfter;
      const retry =
        answer.code === 429 &&
        wait !== undefined &&
        wait <= this.#maxRetryAfter &&
        attempt <= this.#maxRetries;
      if (!retry) throw this.#apiError(method, answer);
      this.#log("telegram.retry", { method, attempt, retryAfter: wait });
      await this.#sleep(wait * 1000, this.#signal);
      if (this.#signal?.aborted) throw this.#failed(method, "cancelled", `${method}: cancelled`);
    }
  }

  async #request(method: string, body: RequestBody, timeoutMs: number): Promise<Answer> {
    const url = `${this.#apiBase}/bot${this.#token.reveal()}/${method}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.#signal ? AbortSignal.any([timeout, this.#signal]) : timeout;
    const headers = typeof body === "string" ? { "content-type": "application/json" } : undefined;
    const started = performance.now();
    let status: number;
    let text: string;
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        signal,
        ...(headers && { headers }),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // Bun's fetch errors keep the URL, token included, in a `path` field, so the error is replaced
      // rather than wrapped: only its name or code is kept.
      throw this.#networkError(method, error, timeoutMs);
    }
    this.#log("telegram.call", {
      method,
      status,
      ms: Math.round(performance.now() - started),
      bytes: text.length,
    });
    const answer = parseAnswer(text);
    if (answer) return answer;
    throw this.#failed(
      method,
      "bad-answer",
      `${method}: unexpected answer (HTTP ${status})`,
      status,
    );
  }

  #networkError(method: string, error: unknown, timeoutMs: number): TelegramError {
    if (this.#signal?.aborted) return this.#failed(method, "cancelled", `${method}: cancelled`);
    if (error instanceof Error && error.name === "TimeoutError") {
      return this.#failed(method, "timeout", `${method}: no answer within ${timeoutMs / 1000} s`);
    }
    return this.#failed(method, "network", `${method}: network error (${errorCode(error)})`);
  }

  #apiError(method: string, answer: Answer): TelegramError {
    const { code, retryAfter } = answer;
    const description = this.#scrub(answer.description ?? "no description").slice(0, 200);
    const kind = code === 429 ? "flood" : "api";
    this.#log("telegram.failed", { method, kind, code: code ?? 0 });
    return new TelegramError(
      `${method}: ${code ?? "?"} ${description}`,
      method,
      kind,
      code,
      retryAfter,
    );
  }

  #failed(method: string, kind: TelegramErrorKind, message: string, code?: number): TelegramError {
    this.#log("telegram.failed", { method, kind, code: code ?? 0 });
    return new TelegramError(message, method, kind, code);
  }

  #shaped<T>(value: T | undefined, method: string): T {
    if (value === undefined) throw this.#badAnswer(method);
    return value;
  }

  #badAnswer(method: string): TelegramError {
    return this.#failed(method, "bad-answer", `${method}: unexpected answer`);
  }

  /** Masks the token's secret part, in case an answer quotes a URL. */
  #scrub(text: string): string {
    const token = this.#token.reveal();
    const secret = token.slice(token.indexOf(":") + 1);
    return secret.length >= 8 ? text.replaceAll(secret, "<token>") : text;
  }
}

/** Waits `ms`, or until `signal` aborts, so a cancel doesn't sit out a 429 wait; clears the timer. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function json(value: unknown): () => string {
  return () => JSON.stringify(value);
}
