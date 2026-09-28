import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { label, Sessions } from "../../src/broker/sessions.ts";

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
  expect(all.touch(ref)).toEqual({ ...ref, branch: "", generation: 0, ended: false });
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
