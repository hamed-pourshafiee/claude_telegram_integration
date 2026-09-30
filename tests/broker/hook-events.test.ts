import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { firstName, HookEvents } from "../../src/broker/hook-events.ts";
import { Inbox } from "../../src/broker/inbox.ts";
import type { Notice } from "../../src/broker/notices.ts";
import type { NoticeOf } from "../../src/broker/notifier.ts";
import type { PairedUser } from "../../src/broker/pairing.ts";
import { Relay } from "../../src/broker/relay.ts";
import { label, type Session, Sessions } from "../../src/broker/sessions.ts";
import { Waiters } from "../../src/broker/waiters.ts";
import { noLog } from "../../src/shared/log.ts";
import { noAskRelay } from "../helpers/no-asks.ts";
import { until } from "../helpers/wait.ts";

// Plan 2.7: what the broker does with the hooks' calls. A stop's ✅ goes out once, only for a real
// finish in the stop's own generation (flow 1, flow 2).
const dir = mkdtempSync(join(tmpdir(), "tg-hook-events-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
let sends: { kind: string; notice: Notice }[];
let goesOut: boolean;
let user: PairedUser | undefined;
let events: HookEvents;
let sessions: Sessions;
beforeEach(() => {
  files += 1;
  sends = [];
  goesOut = true;
  user = { id: 4242, name: "Hamed (@someone)" };
  const notifier = {
    send: (kind: string, session: Session, noticeOf: NoticeOf) => {
      sends.push({ kind, notice: noticeOf(label(session), "full") });
      return Promise.resolve(goesOut);
    },
  };
  const db = BrokerDb.open(join(dir, `events-${files}.db`));
  sessions = new Sessions(db);
  const relay = new Relay({
    db,
    sessions,
    waiters: new Waiters(db),
    inbox: new Inbox(db),
    tell: () => Promise.resolve(),
    senderName: () => "Hamed",
    log: noLog,
  });
  const pairing = { pairedUser: () => user };
  // Folders under /work/private are ping-only: Claude's text, a session's title too, stays on the Mac.
  const showsText = (projectDir: string) => !projectDir.startsWith("/work/private");
  events = new HookEvents({
    sessions,
    notifier,
    pairing,
    relay,
    asks: noAskRelay,
    log: noLog,
    showsText,
  });
});

const ref = { session_id: "b1e81638", project_dir: "/work/sandbox", entrypoint: "cli" };
/** The answer to a hook's call; only a Wait is answered later, and these tests make none. */
const call = (event: string, fields: object = {}): Answer => {
  const answer = events.handle(event, { ...ref, ...fields });
  if (answer instanceof Promise) throw new Error(`${event} answered later`);
  return answer;
};
const stop = () => (call("Stop").body as { generation: number }).generation;
const result = (generation: number, outcome: string, text = "All done.") =>
  call("StopResult", { generation, outcome, text, tasks: [] });
const settled = () => Bun.sleep(5);

describe("a stop", () => {
  test("a real finish in its own generation: one ✅ with the reply", async () => {
    result(stop(), "finish");
    expect(await until(() => sends.length === 1)).toBe(true);
    expect(sends[0]).toEqual({
      kind: "finish",
      notice: { header: "✅ sandbox · b1e8", body: "All done." },
    });
  });

  test("typed at the Mac before the result came: nothing (the cancel barrier)", async () => {
    const generation = stop();
    call("UserPromptSubmit");
    expect(result(generation, "finish").body).toMatchObject({ current: false });
    await settled();
    expect(sends).toEqual([]);
  });

  test("continuing, or unknown: nothing, until idle_prompt confirms an unknown one", async () => {
    result(stop(), "continuing");
    call("Idle");
    await settled();
    expect(sends).toEqual([]);
    result(stop(), "unknown");
    await settled();
    expect(sends).toEqual([]);
    call("Idle");
    expect(await until(() => sends.length === 1)).toBe(true);
  });

  test("idle_prompt after a ✅ that went out: no second one", async () => {
    result(stop(), "finish");
    await settled();
    call("Idle");
    await settled();
    expect(sends).toHaveLength(1);
  });

  test("a ✅ held back because you were at the Mac: idle_prompt sends it if you left", async () => {
    goesOut = false;
    result(stop(), "finish");
    await settled();
    goesOut = true;
    call("Idle");
    await settled();
    expect(sends).toHaveLength(2);
  });
});

describe("after SessionEnd", () => {
  test("an older stop's result is dropped, and a late report doesn't reopen the session", async () => {
    const generation = stop();
    call("SessionEnd", { reason: "other" });
    // The panel closed while its Stop hook read the transcript (the Codex review).
    result(generation, "finish");
    call("Idle");
    await settled();
    expect(sends).toEqual([]);
    expect(sessions.get(ref.session_id)?.ended).toBe(true);
    // A Stop that comes after it too: the panel closed just as the turn ended.
    call("Stop");
    expect(sessions.get(ref.session_id)?.ended).toBe(true);
    // Resumed: it lives again.
    call("SessionStart");
    expect(sessions.get(ref.session_id)?.ended).toBe(false);
  });
});

describe("a session's title (plan 7.2)", () => {
  test("a hook's call brings it, and the ✅ names the session by it", async () => {
    const generation = (call("Stop", { title: "Fix the login bug" }).body as { generation: number })
      .generation;
    result(generation, "finish");
    expect(await until(() => sends.length === 1)).toBe(true);
    expect(sends[0]?.notice.header).toBe("✅ Fix the login bug");
  });

  test("a waiting hook's call brings a new one too", () => {
    call("SessionStart", { title: "First title" });
    call("Confirm", { title: "Renamed", generation: 1, update_id: 1 });
    expect(sessions.get(ref.session_id)?.title).toBe("Renamed");
  });

  test("a ping-only folder keeps its sessions' titles off the chat", () => {
    call("SessionStart", { project_dir: "/work/private/app", title: "Secret plan" });
    expect(sessions.get(ref.session_id)?.title).toBe("");
  });
});

describe("the other events", () => {
  test("SessionStart answers the paired user's first name, for the note", () => {
    expect(call("SessionStart", { branch: "main" }).body).toMatchObject({ name: "Hamed" });
    user = undefined;
    expect(call("SessionStart").body).toMatchObject({ name: null });
  });

  test("a permission, a question and an API error each send their notice", async () => {
    call("PermissionRequest", { tool: "Bash", input: { command: "make" } });
    call("Question", { questions: [{ question: "Which?", options: [{ label: "A" }] }] });
    call("StopFailure", { error: "rate_limit" });
    expect(await until(() => sends.length === 3)).toBe(true);
    expect(sends.map((send) => send.kind)).toEqual(["permission", "question", "failure"]);
    expect(sends[0]?.notice.body).toStartWith("Bash: make");
  });

  test("no session, or a bad stop result: 400", async () => {
    expect(await events.handle("Stop", { entrypoint: "cli" })).toMatchObject({ status: 400 });
    expect(call("StopResult", { generation: "one" }).status).toBe(400);
  });
});

test("the first name, from the name pairing stores", () => {
  expect(firstName("Hamed (@someone)")).toBe("Hamed");
  expect(firstName("Ana María")).toBe("Ana María");
  expect(firstName(undefined)).toBeNull();
});
