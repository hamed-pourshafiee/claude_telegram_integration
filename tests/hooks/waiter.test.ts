import { beforeEach, describe, expect, test } from "bun:test";
import { type WaitBody, type WaiterDeps, waitForReply } from "../../src/hooks/waiter.ts";
import { noLog } from "../../src/shared/log.ts";

// Plan 3.1: a Stop hook's wait for a reply, against a stand-in broker that answers call by call.
const body: WaitBody = {
  session_id: "b1e81638",
  project_dir: "/work/sandbox",
  entrypoint: "cli",
  generation: 7,
  pid: 5001,
  claude_pid: 5000,
};
const REPLY = { state: "reply", update_id: 900, text: "now say bye", from: "Hamed" };

let names: string[];
let starts: number;
let alive: boolean;
let disabled: boolean;
let terminated: AbortController;
beforeEach(() => {
  [names, starts, alive, disabled] = [[], 0, true, false];
  terminated = new AbortController();
});

/** Answers from `script` in order, one per call; "hang" waits for the call's signal, like a held Wait. */
function deps(script: unknown[]): WaiterDeps {
  return {
    call: (name, _body, _timeoutMs, signal) => {
      names.push(name);
      const next = script.shift();
      if (next !== "hang") return Promise.resolve(next);
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
    },
    ensureBroker: () => {
      starts += 1;
      return Promise.resolve(true);
    },
    disabled: () => disabled,
    claudeAlive: () => alive,
    signal: terminated.signal,
    log: noLog,
    retryMs: 5,
    watchMs: 10,
  };
}

describe("a reply", () => {
  test("after the broker's holds, it is confirmed, then returned", async () => {
    const script = [{ state: "waiting" }, { state: "waiting" }, REPLY, { delivered: true }];
    const result = await waitForReply(body, deps(script));
    expect(result).toEqual({ kind: "reply", text: "now say bye", from: "Hamed" });
    expect(names).toEqual(["Wait", "Wait", "Wait", "Confirm"]);
  });

  test("the broker gone and back: started again, and the wait carries on", async () => {
    const script = [undefined, undefined, REPLY, undefined, { delivered: true }];
    const result = await waitForReply(body, deps(script));
    expect(result.kind).toBe("reply");
    expect(starts).toBe(3);
  });

  test("a confirm refused, or never answered: nothing to inject", async () => {
    expect(await waitForReply(body, deps([REPLY, { delivered: false }]))).toEqual({
      kind: "none",
      why: "confirm refused",
    });
    const silent = [REPLY, ...Array.from({ length: 20 }, () => undefined)];
    expect(await waitForReply(body, deps(silent))).toEqual({ kind: "none", why: "confirm failed" });
  });
});

describe("no reply", () => {
  test("cancelled (you typed at the Mac), or stale (a newer stop): the broker's word", async () => {
    expect(await waitForReply(body, deps([{ state: "cancelled" }]))).toEqual({
      kind: "none",
      why: "cancelled",
    });
    expect(await waitForReply(body, deps([{ state: "stale" }]))).toEqual({
      kind: "none",
      why: "stale",
    });
  });

  test("the disabled flag: it stops before the next call", async () => {
    const waiting = deps([{ state: "waiting" }, "hang"]);
    const call = waiting.call;
    const result = waitForReply(body, {
      ...waiting,
      call: (...args) => {
        disabled = true;
        return call(...args);
      },
    });
    expect(await result).toEqual({ kind: "none", why: "disabled" });
    expect(names).toEqual(["Wait"]);
  });

  test("Claude gone during a held Wait: the call is cut, and the wait ends", async () => {
    const result = waitForReply(body, deps(["hang"]));
    await Bun.sleep(30);
    alive = false;
    expect(await result).toEqual({ kind: "none", why: "claude gone" });
  });

  test("SIGTERM during a held Wait, or before the confirm", async () => {
    const held = waitForReply(body, deps(["hang"]));
    terminated.abort();
    expect(await held).toEqual({ kind: "none", why: "terminated" });
    terminated = new AbortController();
    const script = deps([REPLY, "hang"]);
    const confirming = waitForReply(body, script);
    await Bun.sleep(20);
    terminated.abort();
    expect(await confirming).toEqual({ kind: "none", why: "stopped before confirming" });
  });
});
