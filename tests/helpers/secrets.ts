import { expect } from "bun:test";

// Built at runtime, so no token-shaped text sits in the source for a secret scan to trip over.
export const FAKE_SECRET: string = "AAHd9x_Qk-7pZr".repeat(3).slice(0, 35);
export const FAKE_TOKEN: string = `${"7".repeat(10)}:${FAKE_SECRET}`;

/** No 8-character piece of the token's secret part appears in `text`. */
export function expectNoLeak(text: string, secret: string = FAKE_SECRET): void {
  for (let start = 0; start + 8 <= secret.length; start++) {
    expect(text).not.toContain(secret.slice(start, start + 8));
  }
}
