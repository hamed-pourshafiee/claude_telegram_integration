import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotToken, TOKEN_KEY } from "../../src/shared/env.ts";
import { ConfigError } from "../../src/shared/errors.ts";
import { Secret } from "../../src/shared/secret.ts";
import { expectNoLeak, FAKE_SECRET, FAKE_TOKEN } from "../helpers/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "tg-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
/** A .env file holding `text`, at `mode` (set after writing, so the umask can't change it). */
function envFile(text: string, mode = 0o600): string {
  files += 1;
  const path = join(dir, `env-${files}`);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

/** The message of the ConfigError that loading `path` throws, checked to hold no part of the token. */
function loadError(path: string): string {
  try {
    loadBotToken(path);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    expectNoLeak(error.message);
    return error.message;
  }
  throw new Error("loadBotToken did not throw");
}

describe("loadBotToken reads the token from the file", () => {
  test("a plain line", () => {
    expect(loadBotToken(envFile(`${TOKEN_KEY}=${FAKE_TOKEN}\n`)).reveal()).toBe(FAKE_TOKEN);
  });

  test.each([
    ["double quotes", `${TOKEN_KEY}="${FAKE_TOKEN}"`],
    ["single quotes", `${TOKEN_KEY}='${FAKE_TOKEN}'`],
    ["export and spaces", `export ${TOKEN_KEY} = ${FAKE_TOKEN}  `],
    ["a trailing comment", `${TOKEN_KEY}=${FAKE_TOKEN} # my bot`],
    ["CRLF, a BOM and other keys", `﻿# bot\r\nOTHER=1\r\n\r\n${TOKEN_KEY}=${FAKE_TOKEN}\r\n`],
    ["the template's comments", `# Copy to .env\n# Fill in\n\n${TOKEN_KEY}=${FAKE_TOKEN}\n`],
  ])("with %s", (_name, text) => {
    expect(loadBotToken(envFile(text)).reveal()).toBe(FAKE_TOKEN);
  });

  test("a read-only file (mode 400) is fine", () => {
    expect(loadBotToken(envFile(`${TOKEN_KEY}=${FAKE_TOKEN}`, 0o400)).reveal()).toBe(FAKE_TOKEN);
  });

  test("never from process.env, which another repo's session may set (F13)", () => {
    const saved = process.env[TOKEN_KEY];
    process.env[TOKEN_KEY] = `1234567:${"B".repeat(35)}`;
    try {
      expect(loadBotToken(envFile(`${TOKEN_KEY}=${FAKE_TOKEN}`)).reveal()).toBe(FAKE_TOKEN);
      expect(loadError(envFile("OTHER=1\n"))).toContain(`no ${TOKEN_KEY} line`);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, TOKEN_KEY);
      else process.env[TOKEN_KEY] = saved;
    }
  });
});

describe("a missing or invalid token gives a clear error that never shows it", () => {
  test("no .env", () => {
    expect(loadError(join(dir, "absent"))).toContain("Create it from .env.example with mode 600");
  });

  test.each([0o644, 0o640, 0o604, 0o660])("mode %o is refused", (mode) => {
    expect(loadError(envFile(`${TOKEN_KEY}=${FAKE_TOKEN}`, mode))).toContain("chmod 600 .env");
  });

  test("a folder named .env", () => {
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(loadError(folder)).toContain("not a regular file");
  });

  test.each([
    ["no token line", "OTHER=1\n", `no ${TOKEN_KEY} line`],
    ["the template as created", `# comment\n${TOKEN_KEY}=\n`, "is empty"],
    ["the token on its own line", `${TOKEN_KEY}=\n${FAKE_TOKEN}\n`, "line 2 is not KEY=value"],
    ["BotFather's whole sentence", `${TOKEN_KEY}=Use this token: ${FAKE_TOKEN}`, "contains spaces"],
    ["an unbalanced quote", `${TOKEN_KEY}="${FAKE_TOKEN}`, "quote marks"],
    ["no colon", `${TOKEN_KEY}=${FAKE_SECRET}`, "has no colon"],
    [
      "letters before the colon",
      `${TOKEN_KEY}=bot${FAKE_TOKEN}`,
      "before the colon is not a number",
    ],
    ["a cut-off token", `${TOKEN_KEY}=${FAKE_TOKEN.slice(0, 30)}`, "after the colon"],
    ["the key twice", `${TOKEN_KEY}=${FAKE_TOKEN}\n${TOKEN_KEY}=${FAKE_TOKEN}\n`, "twice"],
  ])("%s", (_name, text, expected) => {
    const message = loadError(envFile(text));
    expect(message).toContain(expected);
    expect(message).not.toContain(FAKE_TOKEN);
  });
});

describe("a Secret never prints its value", () => {
  const secret = new Secret(FAKE_TOKEN);

  test.each([
    ["String()", () => String(secret)],
    ["a template string", () => `token: ${secret}`],
    ["JSON", () => JSON.stringify({ token: secret })],
    ["Bun.inspect, as console.log prints it", () => Bun.inspect({ nested: { token: secret } })],
  ])("%s", (_name, render) => {
    const text = render();
    expect(text).toContain("[secret]");
    expectNoLeak(text);
  });

  test("reveal() returns it", () => {
    expect(secret.reveal()).toBe(FAKE_TOKEN);
  });

  test("fingerprint(): 16 hex digits, the same for the same value, different for another", () => {
    expect(secret.fingerprint()).toMatch(/^[0-9a-f]{16}$/);
    expect(new Secret(FAKE_TOKEN).fingerprint()).toBe(secret.fingerprint());
    expect(new Secret(`${FAKE_TOKEN}x`).fingerprint()).not.toBe(secret.fingerprint());
    expectNoLeak(secret.fingerprint());
  });
});
