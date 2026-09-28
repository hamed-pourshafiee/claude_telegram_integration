import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { BrokerDb } from "./db.ts";

/** Letters and digits that can't be mistaken for each other (no 0/O, 1/I/L or U). */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_MINUTES = 10;
export const MAX_ATTEMPTS = 5;

/** The Telegram user the bridge answers to (design §5). */
export interface PairedUser {
  readonly id: number;
  readonly name: string;
}

export type PairingResult =
  | { readonly outcome: "paired"; readonly user: PairedUser }
  | { readonly outcome: "wrong"; readonly attemptsLeft: number }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "none" };

const KEYS = {
  codeHash: "pairing.code_sha256",
  expiresAt: "pairing.expires_at",
  attempts: "pairing.attempts",
  userId: "paired.user_id",
  userName: "paired.user_name",
  pairedAt: "paired.at",
} as const;

/**
 * Pairing (plan 2.4). `start` makes a one-time code, valid PAIRING_MINUTES; only its hash is stored.
 * The first `attempt` with that code pairs its sender, replacing any earlier pairing. MAX_ATTEMPTS wrong
 * codes cancel the pending pairing, so the code can't be guessed.
 */
export class Pairing {
  readonly #db: BrokerDb;
  readonly #now: () => number;

  constructor(db: BrokerDb, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** A new code, shown as XXXX-XXXX; it replaces a pending one. */
  start(): { readonly code: string; readonly expiresAt: number } {
    const code = Array.from({ length: CODE_LENGTH }, () =>
      ALPHABET.charAt(randomInt(ALPHABET.length)),
    );
    const expiresAt = this.#now() + PAIRING_MINUTES * 60_000;
    this.#db.transaction(() => {
      this.#db.setMeta(KEYS.codeHash, sha256(code.join("")));
      this.#db.setMeta(KEYS.expiresAt, String(expiresAt));
      this.#db.setMeta(KEYS.attempts, "0");
    });
    return { code: `${code.slice(0, 4).join("")}-${code.slice(4).join("")}`, expiresAt };
  }

  /** When the pending pairing expires, or undefined if none is pending. */
  pendingUntil(): number | undefined {
    const expiresAt = Number(this.#db.getMeta(KEYS.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt === 0) return undefined;
    if (expiresAt > this.#now()) return expiresAt;
    this.#clear();
    return undefined;
  }

  /** Tries `code` (as typed: any case, dashes and spaces ignored) for `user`. */
  attempt(code: string, user: PairedUser): PairingResult {
    if (this.pendingUntil() === undefined) return { outcome: "none" };
    if (sameHash(sha256(normalize(code)), this.#db.getMeta(KEYS.codeHash) ?? "")) {
      this.#db.transaction(() => {
        this.#clear();
        this.#db.setMeta(KEYS.userId, String(user.id));
        this.#db.setMeta(KEYS.userName, user.name);
        this.#db.setMeta(KEYS.pairedAt, new Date(this.#now()).toISOString());
      });
      return { outcome: "paired", user };
    }
    const attempts = Number(this.#db.getMeta(KEYS.attempts) ?? "0") + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.#clear();
      return { outcome: "cancelled" };
    }
    this.#db.setMeta(KEYS.attempts, String(attempts));
    return { outcome: "wrong", attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  pairedUser(): PairedUser | undefined {
    const id = Number(this.#db.getMeta(KEYS.userId));
    const name = this.#db.getMeta(KEYS.userName);
    return Number.isSafeInteger(id) && id !== 0 && name !== undefined ? { id, name } : undefined;
  }

  #clear(): void {
    this.#db.transaction(() => {
      for (const key of [KEYS.codeHash, KEYS.expiresAt, KEYS.attempts]) this.#db.deleteMeta(key);
    });
  }
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Compares two hex hashes in constant time. */
function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
