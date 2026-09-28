import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { MAX_ATTEMPTS, PAIRING_MINUTES, Pairing } from "../../src/broker/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "tg-pairing-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
/** A Pairing on a new database, with a clock the test moves. */
function setup(start = 1_790_000_000_000) {
  files += 1;
  const file = join(dir, `pairing-${files}.db`);
  let now = start;
  const pairing = new Pairing(BrokerDb.open(file), () => now);
  const advance = (ms: number) => {
    now += ms;
  };
  return { file, pairing, advance };
}

const you = { id: 4242, name: "Hamed (@hamed)" };
const other = { id: 666, name: "Mallory" };

describe("a pairing code", () => {
  test("is 8 unambiguous characters, shown as XXXX-XXXX, valid for 10 minutes", () => {
    const { pairing } = setup(1000);
    const { code, expiresAt } = pairing.start();
    expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(expiresAt).toBe(1000 + PAIRING_MINUTES * 60_000);
    expect(pairing.pendingUntil()).toBe(expiresAt);
  });

  test("pairs its sender once, typed in any case, with or without the dash", () => {
    const { pairing } = setup();
    const { code } = pairing.start();
    const typed = ` ${code.toLowerCase().replace("-", "")} `;
    expect(pairing.attempt(typed, you)).toEqual({ outcome: "paired", user: you });
    expect(pairing.pairedUser()).toEqual(you);
    expect(pairing.pendingUntil()).toBeUndefined();
    expect(pairing.attempt(code, other)).toEqual({ outcome: "none" });
    expect(pairing.pairedUser()).toEqual(you);
  });

  test("is refused when wrong, and MAX_ATTEMPTS wrong codes cancel the pairing", () => {
    const { pairing } = setup();
    const { code } = pairing.start();
    for (let left = MAX_ATTEMPTS - 1; left >= 1; left -= 1) {
      expect(pairing.attempt("AAAA-AAAA", other)).toEqual({ outcome: "wrong", attemptsLeft: left });
    }
    expect(pairing.attempt("AAAA-AAAA", other)).toEqual({ outcome: "cancelled" });
    expect(pairing.attempt(code, you)).toEqual({ outcome: "none" });
    expect(pairing.pairedUser()).toBeUndefined();
  });

  test("is refused once it has expired", () => {
    const { pairing, advance } = setup();
    const { code } = pairing.start();
    advance(PAIRING_MINUTES * 60_000 - 1);
    expect(pairing.pendingUntil()).toBeDefined();
    advance(1);
    expect(pairing.pendingUntil()).toBeUndefined();
    expect(pairing.attempt(code, you)).toEqual({ outcome: "none" });
    expect(pairing.pairedUser()).toBeUndefined();
  });
});

describe("pairing state", () => {
  test("the code is stored only as a hash", () => {
    const { file, pairing } = setup();
    const { code } = pairing.start();
    const raw = new Database(file, { readonly: true });
    const values = raw.query<{ value: string }, []>("SELECT value FROM meta").all();
    raw.close();
    expect(values.length).toBeGreaterThan(0);
    for (const { value } of values) {
      expect(value).not.toContain(code.replace("-", ""));
      expect(value).not.toContain(code.slice(0, 4));
    }
  });

  test("a later pairing replaces the paired user, once it succeeds", () => {
    const { pairing } = setup();
    pairing.attempt(pairing.start().code, you);
    const { code } = pairing.start();
    expect(pairing.pairedUser()).toEqual(you);
    expect(pairing.attempt(code, other)).toEqual({ outcome: "paired", user: other });
    expect(pairing.pairedUser()).toEqual(other);
  });
});
