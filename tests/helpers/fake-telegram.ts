// A local stand-in for the Telegram Bot API (plan 2.2). Answers are queued per method, and every
// request is recorded with the token from its URL.

export type FakeAnswer =
  | { readonly status?: number; readonly json: unknown; readonly delayMs?: number }
  | { readonly status: number; readonly text: string }
  | { readonly hang: true };

export interface Received {
  readonly method: string;
  /** The token in the request's URL. */
  readonly token: string;
  /** The JSON body, or the fields of a form upload, with a file as { name, type, content }. */
  readonly body: unknown;
}

export function ok(result: unknown): FakeAnswer {
  return { json: { ok: true, result } };
}

export function apiError(code: number, description: string): FakeAnswer {
  return { status: code, json: { ok: false, error_code: code, description } };
}

export function tooManyRequests(retryAfter: number): FakeAnswer {
  const description = `Too Many Requests: retry after ${retryAfter}`;
  return {
    status: 429,
    json: { ok: false, error_code: 429, description, parameters: { retry_after: retryAfter } },
  };
}

export class FakeTelegram {
  #received: Received[] = [];
  readonly #answers = new Map<string, FakeAnswer[]>();
  readonly #fallbacks = new Map<string, FakeAnswer>();
  readonly #server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => this.#answer(request),
  });

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /** Queues answers for `method`, used in order; a call with none left gets a 404 answer. */
  answer(method: string, ...answers: FakeAnswer[]): void {
    this.#answers.set(method, [...(this.#answers.get(method) ?? []), ...answers]);
  }

  /** The answer for `method` once its queue is empty (instead of a 404), until the next reset. */
  fallback(method: string, answer: FakeAnswer): void {
    this.#fallbacks.set(method, answer);
  }

  /** The requests for `method` since the last reset. */
  calls(method: string): Received[] {
    return this.#received.filter((received) => received.method === method);
  }

  reset(): void {
    this.#received = [];
    this.#answers.clear();
    this.#fallbacks.clear();
  }

  stop(): void {
    this.#server.stop(true);
  }

  async #answer(request: Request): Promise<Response> {
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(request.url).pathname);
    const method = match?.[2] ?? "";
    const token = decodeURIComponent(match?.[1] ?? "");
    this.#received.push({ method, token, body: await readBody(request) });
    const queued = this.#answers.get(method)?.shift();
    const answer = queued ?? this.#fallbacks.get(method) ?? apiError(404, "Not Found");
    if ("hang" in answer) return new Promise<Response>(() => undefined);
    if ("text" in answer) return new Response(answer.text, { status: answer.status });
    if (answer.delayMs !== undefined) await Bun.sleep(answer.delayMs);
    return Response.json(answer.json, { status: answer.status ?? 200 });
  }
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) return JSON.parse(await request.text());
  const fields: Record<string, unknown> = {};
  for (const [key, value] of (await request.formData()).entries()) {
    fields[key] =
      typeof value === "string"
        ? value
        : { name: value.name, type: value.type, content: await value.text() };
  }
  return fields;
}
