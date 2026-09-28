import { describe, expect, test } from "bun:test";
import { redact } from "../../src/broker/redact.ts";

// Findings of the Codex review of 2.5, each reproduced here before it was fixed.

/** Every word of `secret` of 3 characters or more: a half-masked value still leaks those. */
const words = (secret: string) => secret.split(/[\s,]+/).filter((word) => word.length >= 3);

describe("a secret setting's whole value is masked, spaces and commas included", () => {
  test.each([
    ['PASSWORD="correct horse battery staple"', "correct horse battery staple", 'PASSWORD="'],
    ["password: 'Zebra Quilt, Mango'", "Zebra Quilt, Mango", "password: '"],
    ['  "api_key": "Kiwi Plum",', "Kiwi Plum", '"api_key": "'],
    ["DB_PASSWORD=Walnut Hazel", "Walnut Hazel", "DB_PASSWORD="],
    ["secret: Tangerine # the old one", "Tangerine", "secret: "],
    ['token = "abc"', "abc", 'token = "'],
  ])("%s", (line, secret, kept) => {
    const { text, count } = redact(line);
    for (const word of words(secret)) expect(text).not.toContain(word);
    expect(text).toContain(kept);
    expect(count).toBe(1);
  });
});

describe("an explicit Authorization header is masked, however short its credential", () => {
  test.each([
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz", "Authorization: Basic "],
    ["Authorization: Bearer abc123", "abc123", "Authorization: Bearer "],
    [
      'curl -H "Authorization: Token t0k3n9" https://example.com',
      "t0k3n9",
      "Authorization: Token ",
    ],
    ["Proxy-Authorization: Basic Zm9vOmJhcg==", "Zm9vOmJhcg==", "Proxy-Authorization: Basic "],
    ["authorization: xyz789abc", "xyz789abc", "authorization: "],
  ])("%s", (line, secret, kept) => {
    const { text, count } = redact(line);
    expect(text).not.toContain(secret);
    expect(text).toContain(kept);
    expect(count).toBe(1);
  });
});
