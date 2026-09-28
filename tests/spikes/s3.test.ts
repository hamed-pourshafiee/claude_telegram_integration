import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, SPIKE_DIR } from "../../scripts/spikes/lib.ts";
import { detailOf, redact } from "../../scripts/spikes/s3-record.ts";

const home = "/Users/tester";
// Built at run time, so no secret-shaped literal sits in the repo.
const secrets = {
  openai: `sk-${"a".repeat(24)}`,
  aws: `AKIA${"B".repeat(16)}`,
  telegram: `${"1".repeat(9)}:${"C".repeat(35)}`,
  bearer: `Bearer ${"d".repeat(32)}`,
  github: `ghp_${"E".repeat(36)}`,
  key: `-----BEGIN RSA PRIVATE KEY-----\n${"F".repeat(40)}\n-----END RSA PRIVATE KEY-----`,
};

describe("redact", () => {
  test("shortens the home path, also inside Claude's sanitized project paths", () => {
    expect(
      redact(
        {
          cwd: `${home}/src/app/sandbox`,
          transcript_path: `${home}/.claude/projects/-Users-tester-src-app/x.jsonl`,
          scratchpad_dir: "/private/tmp/claude-501/-Users-tester-src-app/s1/scratchpad",
        },
        home,
      ),
    ).toEqual({
      cwd: "~/src/app/sandbox",
      transcript_path: "~/.claude/projects/-Users-USER-src-app/x.jsonl",
      scratchpad_dir: "/private/tmp/claude-501/-Users-USER-src-app/s1/scratchpad",
    });
  });

  test("masks every secret family, in nested values too", () => {
    const input = { prompt: Object.values(secrets).join(" | "), nested: [{ text: secrets.aws }] };
    const out = JSON.stringify(redact(input, home));
    for (const secret of Object.values(secrets)) expect(out).not.toContain(secret);
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(Object.keys(secrets).length + 1);
  });

  test("keeps look-alikes, numbers and booleans", () => {
    const input = { text: "<task-notification> sk-short", n: 3, flag: true, none: null };
    expect(redact(input, home)).toEqual(input);
  });

  test("caps long strings and says how much was cut", () => {
    expect(redact("x".repeat(4010), home)).toBe(`${"x".repeat(4000)}…[+10 chars]`);
  });

  test("masks a Telegram token inside a Bot API URL, and one that ends in '-'", () => {
    const url = `https://api.telegram.org/bot${secrets.telegram}/getMe`;
    const dashed = `${"2".repeat(10)}:${"G".repeat(34)}-`;
    expect(redact(`${url} ${dashed}/sendMessage`, home)).toBe(
      "https://api.telegram.org/bot[REDACTED]/getMe [REDACTED]/sendMessage",
    );
  });

  test("redacts object keys too, e.g. answers keyed by the question text", () => {
    const question = `Use ${secrets.openai} from ${home}/app?`;
    expect(redact({ answers: { [question]: "yes" } }, home)).toEqual({
      answers: { "Use [REDACTED] from ~/app?": "yes" },
    });
  });
});

test("detailOf names what tells inputs of one event apart", () => {
  expect(detailOf({ hook_event_name: "Notification", notification_type: "idle_prompt" })).toBe(
    "idle_prompt",
  );
  expect(detailOf({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" })).toBe(
    "AskUserQuestion",
  );
  expect(detailOf({ hook_event_name: "SessionStart", source: "startup" })).toBe("startup");
  expect(detailOf({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" })).toBe(
    "prompt_input_exit",
  );
  expect(detailOf({ hook_event_name: "Stop" })).toBe("");
});

test("s3 recorder does nothing outside sandbox/", async () => {
  const log = join(SPIKE_DIR, "s3.log");
  const dir = join(SPIKE_DIR, "s3");
  const before = [
    existsSync(log) ? statSync(log).size : -1,
    existsSync(dir) ? readdirSync(dir) : [],
  ];
  const input = {
    session_id: "test",
    cwd: REPO_ROOT,
    hook_event_name: "UserPromptSubmit",
    prompt: "hi",
  };
  const hook = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${REPO_ROOT}/bunfig.toml`,
      join(REPO_ROOT, "scripts/spikes/s3-record.ts"),
    ],
    { cwd: REPO_ROOT, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    hook.exited,
    new Response(hook.stdout).text(),
    new Response(hook.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  const after = [
    existsSync(log) ? statSync(log).size : -1,
    existsSync(dir) ? readdirSync(dir) : [],
  ];
  expect(after).toEqual(before);
});
