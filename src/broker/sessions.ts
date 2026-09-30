import { basename } from "node:path";
import type { BrokerDb } from "./db.ts";

/** A session as a hook names it. */
export interface SessionRef {
  readonly id: string;
  /** Where it started (CLAUDE_PROJECT_DIR, resolved; F15). */
  readonly projectDir: string;
  readonly entrypoint: string;
}

export interface Session extends SessionRef {
  readonly branch: string;
  readonly generation: number;
  readonly ended: boolean;
  /** When its latest Stop came, in ms since the epoch; 0 before the first. */
  readonly stoppedAt: number;
}

interface Row {
  readonly id: string;
  readonly project_dir: string;
  readonly entrypoint: string;
  readonly branch: string;
  readonly ended_at: string | null;
  readonly generation: number;
  readonly stopped_at: number;
}

/**
 * The sessions the hooks report (design §3). Each has a generation: every Stop starts a new one, and so
 * does typing at the Mac, which cancels the stop before it (flow 2). A stop's result counts only while
 * its generation is still the session's.
 */
export class Sessions {
  readonly #db: BrokerDb;
  readonly #now: () => Date;

  constructor(db: BrokerDb, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * Records the session, or what changed about it (a SessionStart may never have come), as going on:
   * one that ended lives again (resumed, or you typed in it).
   */
  touch(ref: SessionRef, branch?: string): Session {
    return this.#record(ref, branch, true);
  }

  /**
   * Records a session a hook reports on, but never reopens one that ended: a stop's result, say, can
   * come after SessionEnd, when the panel closed while its Stop hook read the transcript.
   */
  seen(ref: SessionRef): Session {
    return this.#record(ref, undefined, false);
  }

  #record(ref: SessionRef, branch: string | undefined, reopen: boolean): Session {
    const reopened = reopen ? ", ended_at = NULL" : "";
    this.#db.run(
      `INSERT INTO sessions (id, project_dir, entrypoint, branch, started_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET project_dir = excluded.project_dir,
         entrypoint = excluded.entrypoint${reopened}`,
      ref.id,
      ref.projectDir,
      ref.entrypoint,
      branch ?? "",
      this.#now().toISOString(),
    );
    if (branch !== undefined)
      this.#db.run("UPDATE sessions SET branch = ? WHERE id = ?", branch, ref.id);
    return (
      this.get(ref.id) ?? {
        ...ref,
        branch: branch ?? "",
        generation: 0,
        ended: false,
        stoppedAt: 0,
      }
    );
  }

  get(id: string): Session | undefined {
    const row = this.#db.get<Row>("SELECT * FROM sessions WHERE id = ?", id);
    return row === undefined ? undefined : fromRow(row);
  }

  /** Starts the session's next generation, which ends the one before; returns its number. */
  advance(id: string): number {
    return this.#db.transaction(() => {
      this.#db.run("UPDATE sessions SET generation = generation + 1 WHERE id = ?", id);
      return this.get(id)?.generation ?? 0;
    });
  }

  /** A Stop: its generation starts, and the session remembers when (a later cancel is late, plan 3.1). */
  stop(id: string): number {
    return this.#db.transaction(() => {
      this.#db.run("UPDATE sessions SET stopped_at = ? WHERE id = ?", this.#now().getTime(), id);
      return this.advance(id);
    });
  }

  end(id: string): void {
    this.#db.run(
      "UPDATE sessions SET ended_at = ?, generation = generation + 1 WHERE id = ?",
      this.#now().toISOString(),
      id,
    );
  }
}

/** How messages name a session: its folder, branch and the start of its id, e.g. "sandbox (main) · b1e8". */
export function label(session: Pick<Session, "id" | "projectDir" | "branch">): string {
  const folder = basename(session.projectDir) || session.projectDir;
  const branch = session.branch ? ` (${session.branch})` : "";
  return `${folder}${branch} · ${session.id.slice(0, 4)}`;
}

function fromRow(row: Row): Session {
  return {
    id: row.id,
    projectDir: row.project_dir,
    entrypoint: row.entrypoint,
    branch: row.branch,
    generation: row.generation,
    ended: row.ended_at !== null,
    stoppedAt: row.stopped_at,
  };
}
