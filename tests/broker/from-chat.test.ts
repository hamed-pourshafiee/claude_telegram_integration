import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskHarness, askHarness, SESSION } from "../helpers/asks.ts";
import { until } from "../helpers/wait.ts";

// Plans 7.7 and 7.8 (D11): a session /new started reports here wherever you are. One in the background
// has no dialog at the Mac, so its questions stay here; a tab's can go back to its dialog.
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

/** The harness, with its session started from the chat, in the background or a tab, or not. */
function harness(how: "background" | "tab" | "normal" = "background"): AskHarness {
  files += 1;
  const h = askHarness(join(dir, `from-chat-${files}.db`));
  const entrypoint = { background: "sdk-cli", tab: "claude-vscode", normal: "cli" }[how];
  const ref = { id: SESSION.session_id, projectDir: SESSION.project_dir, entrypoint };
  if (how === "normal") h.sessions.touch(ref);
  else h.sessions.startedHere(ref, how);
  return h;
}

async function askedHere(h: AskHarness) {
  void h.ask("toolu_1", PICK);
  expect(await until(() => h.posted.length === 1)).toBe(true);
  return h.idOf("toolu_1");
}

test("at the Mac, and with /off, its question comes here, in the background or a tab", async () => {
  for (const how of ["background", "tab"] as const) {
    const h = harness(how);
    h.be("active", "off");
    const id = await askedHere(h);
    expect(h.asks.get(id)?.state).toBe("remote");
  }
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

test("a tab's question moves to its dialog when you're back at the Mac (plan 7.8)", async () => {
  const h = harness("tab");
  const id = await askedHere(h);
  h.be("active");
  expect(h.asks.get(id)?.state).toBe("local");
});

test("another session's question still moves to the Mac when you're back", async () => {
  const h = harness("normal");
  const id = await askedHere(h);
  h.be("active");
  expect(h.asks.get(id)?.state).toBe("local");
});
