import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { cleanTitle, label, Sessions } from "../../src/broker/sessions.ts";
import { SAMPLES } from "../helpers/secret-samples.ts";

// Plan 2.7: the sessions hooks report, and the generation a stop's result must still match (flow 2).
const dir = mkdtempSync(join(tmpdir(), "tg-sessions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
function sessions(): Sessions {
  files += 1;
  return new Sessions(BrokerDb.open(join(dir, `sessions-${files}.db`)));
}
const ref = { id: "b1e81638-e169", projectDir: "/work/sandbox", entrypoint: "claude-vscode" };

test("a session is recorded on its first hook, SessionStart or not, and keeps its branch", () => {
  const all = sessions();
  expect(all.touch(ref)).toEqual({
    ...ref,
    branch: "",
    generation: 0,
    ended: false,
    stoppedAt: 0,
    title: "",
    claudePid: 0,
    promptedAt: 0,
    transcript: "",
  });
  expect(all.touch(ref, "main").branch).toBe("main");
  expect(all.touch(ref).branch).toBe("main");
});

test("each stop, and each prompt typed at the Mac, starts a new generation", () => {
  const all = sessions();
  all.touch(ref);
  expect(all.advance(ref.id)).toBe(1);
  expect(all.advance(ref.id)).toBe(2);
  expect(all.get(ref.id)?.generation).toBe(2);
});

test("ending a session ends its generation too; a later hook brings it back", () => {
  const all = sessions();
  all.touch(ref);
  all.advance(ref.id);
  all.end(ref.id);
  expect(all.get(ref.id)).toMatchObject({ ended: true, generation: 2 });
  expect(all.touch(ref).ended).toBe(false);
});

test("the label: folder, branch and the start of the id", () => {
  expect(label({ id: "b1e81638", projectDir: "/work/sandbox", branch: "main" })).toBe(
    "sandbox (main) · b1e8",
  );
  expect(label({ id: "67c68fde", projectDir: "/work/app", branch: "" })).toBe("app · 67c6");
});

describe("titles (plan 7.2)", () => {
  test("the label is the title once there is one; a call without one keeps it", () => {
    const all = sessions();
    expect(label(all.touch(ref))).toBe("sandbox · b1e8");
    expect(label(all.touch({ ...ref, title: "Fix the login bug" }))).toBe("Fix the login bug");
    expect(all.seen(ref).title).toBe("Fix the login bug");
    all.retitle(ref.id, "Renamed at the Mac");
    expect(label(all.get(ref.id) ?? all.touch(ref))).toBe("Renamed at the Mac");
  });

  test("a folder made ping-only since: its sessions' titles go", () => {
    const all = sessions();
    all.touch({ ...ref, title: "Sandbox work" });
    const other = { ...ref, id: "c2f9", projectDir: "/work/private", title: "Private work" };
    all.touch(other);
    expect(all.forgetTitles((dir) => dir !== "/work/private")).toBe(1);
    expect(all.get("c2f9")?.title).toBe("");
    expect(all.get(ref.id)?.title).toBe("Sandbox work");
  });

  test("a title for the chat: secrets masked, one line, at most 60 characters, an emoji kept whole", () => {
    const github = SAMPLES.find((sample) => sample.family === "GitHub token");
    const masked = cleanTitle(`Rotate ${github?.secret ?? ""}`);
    expect(masked).toBe("Rotate [redacted GitHub token]");
    expect(cleanTitle("  Two\n  lines  ")).toBe("Two lines");
    expect(cleanTitle(" \n ")).toBeUndefined();
    const long = cleanTitle(`${"a".repeat(58)}🙂🙂 and more`);
    expect(long).toBe(`${"a".repeat(58)}🙂…`);
    expect(Array.from(long ?? "")).toHaveLength(60);
  });
});

describe("what /sessions needs (plan 7.3)", () => {
  test("the Claude process a hook brings is kept; a call without one keeps the one before", () => {
    const all = sessions();
    expect(all.touch(ref).claudePid).toBe(0);
    expect(all.touch({ ...ref, claudePid: 4321 }).claudePid).toBe(4321);
    expect(all.seen(ref).claudePid).toBe(4321);
    expect(all.touch({ ...ref, claudePid: 5555 }).claudePid).toBe(5555);
  });

  test("so is its transcript's path, where /sessions reads the title as it is now (plan 7.5)", () => {
    const all = sessions();
    expect(all.touch(ref).transcript).toBe("");
    expect(all.touch({ ...ref, transcript: "/t/one.jsonl" }).transcript).toBe("/t/one.jsonl");
    expect(all.seen(ref).transcript).toBe("/t/one.jsonl");
  });

  test("when a prompt started a turn, and which sessions no SessionEnd has ended", () => {
    const all = sessions();
    all.touch(ref);
    all.prompted(ref.id, 1_700_000_000_000);
    expect(all.get(ref.id)?.promptedAt).toBe(1_700_000_000_000);
    all.touch({ ...ref, id: "c2f9" });
    all.end("c2f9");
    expect(all.open().map((session) => session.id)).toEqual([ref.id]);
  });
});
