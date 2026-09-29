import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "../../src/broker/answer.ts";
import { BrokerDb } from "../../src/broker/db.ts";
import { HookEvents } from "../../src/broker/hook-events.ts";
import { Inbox } from "../../src/broker/inbox.ts";
import type { NoticeOf } from "../../src/broker/notifier.ts";
import { Relay } from "../../src/broker/relay.ts";
import { label, type Session, Sessions } from "../../src/broker/sessions.ts";
import { Waiters } from "../../src/broker/waiters.ts";
import { noLog } from "../../src/shared/log.ts";
import {
  classifiedAt,
  named,
  RECORDINGS,
  type RecordedStop,
  type Recording,
  summaryAt,
} from "../helpers/recordings.ts";
import { until } from "../helpers/wait.ts";

// Plan 2.8: the recorded stops reach the broker as the hooks report them (flow 1, flow 2). Exactly one ✅
// per prompt goes out, with the text of its real finish, and none for a stop whose result came after
// the next prompt was typed.
const dir = mkdtempSync(join(tmpdir(), "tg-stops-recorded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

type Call = (event: string, fields?: object) => { readonly body: unknown };

/** A broker's hook events, with a notifier that keeps the text of each ✅ instead of sending it. */
function broker(): { readonly sent: string[]; readonly call: Call } {
  files += 1;
  const sent: string[] = [];
  const notifier = {
    send: (_kind: string, session: Session, noticeOf: NoticeOf) => {
      sent.push(noticeOf(label(session), "full").body);
      return Promise.resolve(true);
    },
  };
  const db = BrokerDb.open(join(dir, `stops-${files}.db`));
  const sessions = new Sessions(db);
  const pairing = { pairedUser: () => undefined };
  const waiters = new Waiters(db);
  const inbox = new Inbox(db);
  const tell = () => Promise.resolve();
  const relay = new Relay({
    db,
    sessions,
    waiters,
    inbox,
    tell,
    senderName: () => null,
    log: noLog,
  });
  const events = new HookEvents({ sessions, notifier, pairing, relay, log: noLog });
  const ref = { session_id: "5e551011", project_dir: "/work/sandbox", entrypoint: "claude-vscode" };
  const call: Call = (event, fields = {}) => {
    const answer: Answer | Promise<Answer> = events.handle(event, { ...ref, ...fields });
    if (answer instanceof Promise) throw new Error(`${event} answered later`);
    return answer;
  };
  return { sent, call };
}

/**
 * The recording's hook calls in order: UserPromptSubmit per prompt, Stop and its StopResult per stop,
 * the outcome classified once the stop's summary was written. With `late`, each prompt's last result
 * comes only after the next prompt was typed.
 */
function replay(recording: Recording, call: Call, late: boolean): void {
  let prompt = 0;
  let pending: (() => void) | undefined;
  recording.stops.forEach((stop, index) => {
    if (stop.prompt !== prompt) {
      call("UserPromptSubmit");
      pending?.();
      pending = undefined;
      prompt = stop.prompt;
    }
    const { generation } = call("Stop").body as { generation: number };
    const outcome = classifiedAt(recording, stop, summaryAt(recording, stop) + 1)?.outcome;
    const report = () => {
      call("StopResult", { generation, outcome: outcome ?? "unknown", text: stop.text, tasks: [] });
    };
    if (late && recording.stops[index + 1]?.prompt !== stop.prompt) pending = report;
    else report();
  });
  pending?.();
}

const finishes = (stops: readonly RecordedStop[]) =>
  stops.filter((stop) => stop.truth === "finish").map((stop) => stop.text.trim());

describe.each(RECORDINGS.map((recording) => [named(recording), recording] as const))(
  "%s",
  (_, recording) => {
    test("exactly one ✅ per prompt, with its real finish's text", async () => {
      const { sent, call } = broker();
      replay(recording, call, false);
      const expected = finishes(recording.stops);
      expect(await until(() => sent.length >= expected.length)).toBe(true);
      await Bun.sleep(5);
      expect(sent).toEqual(expected);
    });
  },
);

test("a prompt typed before a ✅ went out cancels that ✅, not the next one", async () => {
  const twoPrompts = RECORDINGS.filter((recording) => recording.scenario.startsWith("same-text"));
  expect(twoPrompts.length).toBeGreaterThan(0);
  for (const recording of twoPrompts) {
    const { sent, call } = broker();
    replay(recording, call, true);
    expect(await until(() => sent.length >= 1)).toBe(true);
    await Bun.sleep(5);
    expect(sent).toEqual(finishes(recording.stops).slice(-1));
  }
});
