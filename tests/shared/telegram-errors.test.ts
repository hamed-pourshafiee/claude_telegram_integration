import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Log } from "../../src/shared/log.ts";
import { REPO_ROOT } from "../../src/shared/paths.ts";
import { Secret } from "../../src/shared/secret.ts";
import { TelegramClient, type TelegramOptions } from "../../src/shared/telegram/client.ts";
import { refuseVerboseFetch, TelegramError } from "../../src/shared/telegram/errors.ts";
import { apiError, FakeTelegram, ok, tooManyRequests } from "../helpers/fake-telegram.ts";
import { expectNoLeak, FAKE_TOKEN } from "../helpers/secrets.ts";

const fake = new FakeTelegram();
const lines: string[] = [];
let sleeps: number[] = [];
beforeEach(() => {
  fake.reset();
  sleeps = [];
});
afterAll(() => fake.stop());

const log: Log = (event, fields) => {
  lines.push(JSON.stringify({ event, ...fields }));
};
const bot = { id: 7777777777, is_bot: true, first_name: "Bridge", username: "bridge_test_bot" };
const sent = { message_id: 10, date: 1_790_000_000, chat: { id: 1, type: "private" } };
const hi = { chat_id: 1, text: "hi" };

/** A client that logs to `lines` and records its waits in `sleeps` instead of waiting. */
function client(options: Partial<Omit<TelegramOptions, "token">> = {}): TelegramClient {
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return new TelegramClient({
    token: new Secret(FAKE_TOKEN),
    apiBase: fake.url,
    log,
    sleep,
    ...options,
  });
}

/** The TelegramError that `call` fails with, checked to hold no piece of the token in any form. */
async function failure(call: Promise<unknown>): Promise<TelegramError> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
    for (const text of [error.message, String(error), Bun.inspect(error), JSON.stringify(error)]) {
      expectNoLeak(text);
    }
    return error;
  }
  throw new Error("the call did not fail");
}

describe("a 429 answer is retried after its retry_after", () => {
  test("waits retry_after seconds, then succeeds", async () => {
    fake.answer("sendMessage", tooManyRequests(2), ok(sent));
    expect((await client().sendMessage(hi)).message_id).toBe(10);
    expect(sleeps).toEqual([2000]);
    expect(fake.calls("sendMessage")).toHaveLength(2);
  });

  test("really waits: retry_after 1 takes a second", async () => {
    fake.answer("getMe", tooManyRequests(1), ok(bot));
    const started = performance.now();
    await new TelegramClient({ token: new Secret(FAKE_TOKEN), apiBase: fake.url }).getMe();
    expect(performance.now() - started).toBeGreaterThanOrEqual(990);
    expect(fake.calls("getMe")).toHaveLength(2);
  });

  test("gives up after maxRetries, as kind 'flood' with the retry_after", async () => {
    fake.answer("sendMessage", tooManyRequests(1), tooManyRequests(1), tooManyRequests(1));
    const error = await failure(client({ maxRetries: 2 }).sendMessage(hi));
    expect(error).toMatchObject({ kind: "flood", code: 429, retryAfter: 1 });
    expect(sleeps).toEqual([1000, 1000]);
    expect(fake.calls("sendMessage")).toHaveLength(3);
  });

  test("doesn't wait for a retry_after above the limit", async () => {
    fake.answer("sendMessage", tooManyRequests(120));
    expect(await failure(client().sendMessage(hi))).toMatchObject({
      kind: "flood",
      retryAfter: 120,
    });
    expect(sleeps).toEqual([]);
    expect(fake.calls("sendMessage")).toHaveLength(1);
  });
});

test("a cancel during a 429 wait ends the wait at once (Codex review of 2.2)", async () => {
  fake.answer("getMe", tooManyRequests(1));
  const controller = new AbortController();
  const options = { token: new Secret(FAKE_TOKEN), apiBase: fake.url, log };
  const real = new TelegramClient({ ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const started = performance.now();
  expect(await failure(real.getMe())).toMatchObject({ kind: "cancelled" });
  expect(performance.now() - started).toBeLessThan(500);
  expect(fake.calls("getMe")).toHaveLength(1);
});

describe("failures are TelegramErrors that never show the token", () => {
  test.each([
    [400, "Bad Request: chat not found"],
    [401, "Unauthorized"],
    [409, "Conflict: terminated by other getUpdates request"],
  ])("HTTP %d is not retried", async (code, description) => {
    fake.answer("getMe", apiError(code, description));
    const error = await failure(client().getMe());
    expect(error).toMatchObject({ kind: "api", code, message: `getMe: ${code} ${description}` });
    expect(fake.calls("getMe")).toHaveLength(1);
  });

  test("a description that quotes the URL has the token masked", async () => {
    fake.answer("getMe", apiError(404, `Not Found: /bot${FAKE_TOKEN}/getMe`));
    expect((await failure(client().getMe())).message).toBe(
      "getMe: 404 Not Found: /bot7777777777:<token>/getMe",
    );
  });

  test("an answer that is not JSON", async () => {
    fake.answer("getMe", { status: 502, text: "<html>502 Bad Gateway</html>" });
    expect(await failure(client().getMe())).toMatchObject({ kind: "bad-answer", code: 502 });
  });

  test("an answer of the wrong shape", async () => {
    fake.answer("getMe", ok({ id: "not a number" }));
    expect(await failure(client().getMe())).toMatchObject({ kind: "bad-answer" });
  });

  test("no connection: Bun's error, whose path holds the URL, is replaced", async () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const apiBase = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    const error = await failure(client({ apiBase }).getMe());
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/^getMe: network error \(\w+\)$/);
    expect(error.cause).toBeUndefined();
  });

  test("no answer in time", async () => {
    fake.answer("getMe", { hang: true });
    expect(await failure(client({ timeoutMs: 200 }).getMe())).toMatchObject({
      kind: "timeout",
      message: "getMe: no answer within 0.2 s",
    });
  });

  test("cancelled through the client's signal", async () => {
    fake.answer("getMe", { hang: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(client({ signal: controller.signal }).getMe());
    expect(error.kind).toBe("cancelled");
  });
});

describe("BUN_CONFIG_VERBOSE_FETCH would print every URL, token included", () => {
  test.each(["curl", "1", "true", " TRUE "])("%p is refused", (value) => {
    expect(() => refuseVerboseFetch({ BUN_CONFIG_VERBOSE_FETCH: value })).toThrow("Unset it");
  });

  test.each([undefined, "", "0", "false"])("%p is fine", (value) => {
    expect(() => refuseVerboseFetch({ BUN_CONFIG_VERBOSE_FETCH: value })).not.toThrow();
  });

  // In a process of its own: setting the variable here would turn verbose logging on for the rest of
  // this test run (Bun 1.4.1), and unsetting it would not turn it off again.
  test("the client refuses to start with it set", () => {
    expect(createClientWith({ BUN_CONFIG_VERBOSE_FETCH: "curl" })).toBe("ConfigError");
    expect(createClientWith({})).toBe("created");
  });
});

/** Creates a client in a new Bun process with `extra` in its environment: "created" or the error. */
function createClientWith(extra: Readonly<Record<string, string>>): string {
  const source = (path: string) => JSON.stringify(join(REPO_ROOT, "src/shared", path));
  const code = [
    `import { TelegramClient } from ${source("telegram/client.ts")};`,
    `import { Secret } from ${source("secret.ts")};`,
    `try { new TelegramClient({ token: new Secret("1:x") }); console.log("created"); }`,
    `catch (error) { console.log(error instanceof Error ? error.name : String(error)); }`,
  ].join("\n");
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  if (!("BUN_CONFIG_VERBOSE_FETCH" in extra))
    Reflect.deleteProperty(env, "BUN_CONFIG_VERBOSE_FETCH");
  const config = `--config=${join(REPO_ROOT, "bunfig.toml")}`;
  const run = Bun.spawnSync([process.execPath, config, "-e", code], { env, stderr: "pipe" });
  return run.stdout.toString().trim() || run.stderr.toString().trim();
}

// Runs last: it checks the lines logged by every test above as well.
test("no log line holds the token or a message's text", async () => {
  const text = "a private message text that must not reach the log";
  fake.answer("sendMessage", ok(sent));
  await client().sendMessage({ chat_id: 1, text });
  const all = lines.join("\n");
  expect(lines.length).toBeGreaterThan(20);
  expect(all).toContain('"event":"telegram.retry"');
  expect(all).toContain('"event":"telegram.failed"');
  expectNoLeak(all);
  expect(all).not.toContain(text);
});
