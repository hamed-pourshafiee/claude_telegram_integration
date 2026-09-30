import { basename } from "node:path";
import type { BrokerDb } from "./db.ts";
import { redact } from "./redact.ts";

/** A session as a hook names it. */
export interface SessionRef {
  readonly id: string;
  /** Where it started (CLAUDE_PROJECT_DIR, resolved; F15). */
  readonly projectDir: string;
  readonly entrypoint: string;
  /** Its title, made fit for the chat (cleanTitle), when its folder may show Claude's text (plan 7.2). */
  readonly title?: string;
}

export interface Session extends SessionRef {
  readonly branch: string;
  readonly generation: number;
  readonly ended: boolean;
  /** When its latest Stop came, in ms since the epoch; 0 before the first. */
  readonly stoppedAt: number;
  /** "" until it has one. */
  readonly title: string;
}

interface Row {
  readonly id: string;
  readonly project_dir: string;
  readonly entrypoint: string;
  readonly branch: string;
  readonly ended_at: string | null;
  readonly generation: number;
  readonly stopped_at: number;
  readonly title: string;
}

/** The most of a title the chat shows, in characters. */
const TITLE_CHARS = 60;

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
    // A title comes with the ref once the session has one; one that comes without keeps it.
    this.#db.run(
      `INSERT INTO sessions (id, project_dir, entrypoint, branch, started_at, title)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET project_dir = excluded.project_dir,
         entrypoint = excluded.entrypoint${reopened},
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END`,
      ref.id,
      ref.projectDir,
      ref.entrypoint,
      branch ?? "",
      this.#now().toISOString(),
      ref.title ?? "",
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
        title: ref.title ?? "",
      }
    );
  }

  /** The session's title now (plan 7.2): calls that don't record the session bring it too. */
  retitle(id: string, title: string): void {
    this.#db.run("UPDATE sessions SET title = ? WHERE id = ? AND title <> ?", title, id, title);
  }

  /**
   * Forgets the titles of sessions whose folder no longer shows Claude's text (D8): config.json made it
   * ping-only since. How many.
   */
  forgetTitles(showsText: (projectDir: string) => boolean): number {
    const titled = this.#db.all<Row>("SELECT * FROM sessions WHERE title <> ''");
    const hidden = titled.filter((row) => !showsText(row.project_dir));
    for (const row of hidden) this.#db.run("UPDATE sessions SET title = '' WHERE id = ?", row.id);
    return hidden.length;
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

/**
 * How messages name a session (plan 7.2): by its title, as Claude Code shows it; until it has one, by
 * its folder, branch and the start of its id, e.g. "sandbox (main) · b1e8".
 */
export function label(
  session: Pick<Session, "id" | "projectDir" | "branch"> & { readonly title?: string },
): string {
  if (session.title) return session.title;
  const folder = basename(session.projectDir) || session.projectDir;
  const branch = session.branch ? ` (${session.branch})` : "";
  return `${folder}${branch} · ${session.id.slice(0, 4)}`;
}

/**
 * A title as the chat may show it (D8): secrets masked, on one line, at most 60 characters; undefined
 * when nothing is left.
 */
export function cleanTitle(raw: string): string | undefined {
  const text = redact(raw).text.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length === 0) return undefined;
  if (chars.length <= TITLE_CHARS) return text;
  return `${chars
    .slice(0, TITLE_CHARS - 1)
    .join("")
    .trimEnd()}…`;
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
    title: row.title,
  };
}
