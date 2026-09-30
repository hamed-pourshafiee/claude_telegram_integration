import { afterAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerDb } from "../../src/broker/db.ts";
import { Outbox } from "../../src/broker/outbox.ts";
import { Sessions } from "../../src/broker/sessions.ts";
import { sessionsParts } from "../../src/broker/sessions-command.ts";
import { parseConfig } from "../../src/shared/config.ts";
import { noLog } from "../../src/shared/log.ts";

// Plan 7.5: /sessions names each session by its title as it is now, read from its transcript then:
// Claude Code may have made it since the session's last hook (F21).
const dir = mkdtempSync(join(tmpdir(), "tg-sessions-command-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const folder of ["sandbox", "private"]) mkdirSync(join(dir, folder));
const config = parseConfig(
  { serve: ["sandbox", "private"], content: { pingOnly: ["private"] } },
  { repoRoot: dir, home: dir },
);
let files = 0;
let sessions: Sessions;
let list: () => string;
beforeEach(() => {
  files += 1;
  const db = BrokerDb.open(join(dir, `command-${files}.db`));
  sessions = new Sessions(db);
  const deps = {
    sessions,
    waiters: { listening: () => [] },
    asks: { inState: () => [] },
    alive: (pid: number) => pid === 101,
    telegram: {
      sendMessage: () => Promise.reject(new Error("not in these tests")),
      answerCallbackQuery: () => Promise.resolve(),
    },
    outbox: new Outbox(db),
    log: noLog,
  };
  const parts = sessionsParts(deps, config);
  list = () => parts.list().text;
});

/** A transcript with a first prompt, and the title Claude Code wrote after it, if any. */
function transcript(name: string, title?: string): string {
  const path = join(dir, `${name}-${files}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  if (title !== undefined)
    appendFileSync(path, `${JSON.stringify({ type: "ai-title", aiTitle: title })}\n`);
  return path;
}
const open = (id: string, folder: string, path: string, claudePid = 101) =>
  sessions.touch({
    id,
    projectDir: join(dir, folder),
    entrypoint: "claude-vscode",
    claudePid,
    transcript: path,
  });

test("a title Claude Code made after the session's last hook is shown, and kept for the messages after", () => {
  const path = transcript("new");
  open("93c4408c", "sandbox", path);
  expect(list()).toContain("💤 sandbox · 93c4: idle");
  appendFileSync(path, `${JSON.stringify({ type: "ai-title", aiTitle: "IQ-1572" })}\n`);
  expect(list()).toContain("💤 IQ-1572: idle");
  expect(sessions.get("93c4408c")?.title).toBe("IQ-1572");
});

test("a ping-only folder's transcript isn't read: its session goes by its folder (D8)", () => {
  open("5ec2e700", "private", transcript("private", "The private plan"));
  expect(list()).toContain("💤 private · 5ec2: idle");
  expect(sessions.get("5ec2e700")?.title).toBe("");
});

test("no title yet, no transcript, or one that's gone: the title kept, if any", () => {
  open("aaaa0000", "sandbox", transcript("untitled"));
  sessions.touch({
    id: "bbbb0000",
    projectDir: join(dir, "sandbox"),
    entrypoint: "cli",
    title: "Kept",
  });
  sessions.touch({
    id: "bbbb0000",
    projectDir: join(dir, "sandbox"),
    entrypoint: "cli",
    claudePid: 101,
  });
  open("cccc0000", "sandbox", join(dir, "deleted.jsonl"));
  sessions.retitle("cccc0000", "Kept too");
  const text = list();
  for (const line of ["💤 sandbox · aaaa: idle", "💤 Kept: idle", "💤 Kept too: idle"]) {
    expect(text).toContain(line);
  }
});

test("a session whose Claude has gone isn't listed, and its transcript isn't read", () => {
  open("dddd0000", "sandbox", transcript("gone", "Gone for good"), 999);
  expect(list()).toBe("No sessions are open.");
  expect(sessions.get("dddd0000")?.title).toBe("");
});
