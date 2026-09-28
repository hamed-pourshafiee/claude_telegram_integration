import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { firstName, HookEvents } from "../../src/broker/hook-events.ts";
import type { Notice } from "../../src/broker/notices.ts";
import type { NoticeOf } from "../../src/broker/notifier.ts";
import type { PairedUser } from "../../src/broker/pairing.ts";
import { label, type Session, Sessions } from "../../src/broker/sessions.ts";
import { noLog } from "../../src/shared/log.ts";
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
  const sessions = new Sessions(BrokerDb.open(join(dir, `events-${files}.db`)));
  events = new HookEvents({ sessions, notifier, pairing: { pairedUser: () => user }, log: noLog });
});

const ref = { session_id: "b1e81638", project_dir: "/work/sandbox", entrypoint: "cli" };
const call = (event: string, fields: object = {}) => events.handle(event, { ...ref, ...fields });
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

  test("after SessionEnd, an older stop's result is dropped", async () => {
    const generation = stop();
    call("SessionEnd", { reason: "other" });
    result(generation, "finish");
    await settled();
    expect(sends).toEqual([]);
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

  test("no session, or a bad stop result: 400", () => {
    expect(events.handle("Stop", { entrypoint: "cli" }).status).toBe(400);
    expect(call("StopResult", { generation: "one" }).status).toBe(400);
  });
});

test("the first name, from the name pairing stores", () => {
  expect(firstName("Hamed (@someone)")).toBe("Hamed");
  expect(firstName("Ana María")).toBe("Ana María");
  expect(firstName(undefined)).toBeNull();
});
