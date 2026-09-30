import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskHarness, askHarness, SESSION } from "../helpers/asks.ts";
import { until } from "../helpers/wait.ts";

// Plan 7.7 (D11): a session /new started runs in the background, with no dialog at the Mac, so its
// questions come here wherever you are, and stay here.
const dir = mkdtempSync(join(tmpdir(), "tg-from-chat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const PICK = {
  questions: [
    {
      question: "Which runtime?",
      header: "Runtime",
      options: [{ label: "Bun" }, { label: "Node" }],
    },
  ],
};

/** The harness, with its session started from the chat unless `normal`. */
function harness(normal = false): AskHarness {
  files += 1;
  const h = askHarness(join(dir, `from-chat-${files}.db`));
  const ref = { id: SESSION.session_id, projectDir: SESSION.project_dir, entrypoint: "cli" };
  if (normal) h.sessions.touch(ref);
  else h.sessions.startedHere(ref);
  return h;
}

async function askedHere(h: AskHarness) {
  void h.ask("toolu_1", PICK);
  expect(await until(() => h.posted.length === 1)).toBe(true);
  return h.idOf("toolu_1");
}

test("at the Mac, its question comes here, not to a dialog", async () => {
  const h = harness();
  h.be("active");
  const id = await askedHere(h);
  expect(h.asks.get(id)?.state).toBe("remote");
});

test("back at the Mac, /local and its 🖥 button leave it here", async () => {
  const h = harness();
  const id = await askedHere(h);
  h.be("active");
  expect(h.chat.handBack()).toBe("No question is waiting here.");
  await h.chat.press(`ask:${id}:mac`, "q1");
  expect(h.asks.get(id)?.state).toBe("remote");
  expect(h.toasts.at(-1)?.text).toContain("no dialog at the Mac");
});

test("another session's question still moves to the Mac when you're back", async () => {
  const h = harness(true);
  const id = await askedHere(h);
  h.be("active");
  expect(h.asks.get(id)?.state).toBe("local");
});
