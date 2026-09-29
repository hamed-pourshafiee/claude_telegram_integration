// A throwaway hook for scripts/record-stops.ts (plan 2.8). Claude Code runs it with the hook input on
// stdin. "record" notes each input and the transcript's size at that moment. The others act as another
// Stop hook might: "block" (the first stop of each prompt), "block2" (the first two), "slow" (the first,
// asking for a 25 s command), "context" (additionalContext on the first), "crash" (a non-blocking
// error) and "prevent" (continue: false).
// For a live check that switches between them, a file <dir>/only names the one that acts.
//   bun --no-env-file scripts/throwaway-stop-hook.ts <behavior> <dir>
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.on("unhandledRejection", (reason) => {
  console.error(`throwaway hook: ${String(reason)}`);
  process.exit(0);
});

const [behavior = "", dir = ""] = Bun.argv.slice(2);
const COUNTED = ["block", "block2", "slow", "context"];
const REASON = "Throwaway test hook: add one more short sentence, then stop.";
// Claude Code refuses a foreground `sleep`, and a background one wakes the session again when it ends.
const SLOW = `Throwaway test hook: run this shell command in the foreground, not in the background: python3 -c 'import time; time.sleep(25)'. Then stop.`;

const input: Record<string, unknown> = JSON.parse(await Bun.stdin.text());
if (behavior === "record") record(input);
else act();

/** Appends the input's facts and the transcript's size now; a new prompt resets the counters. */
function record(fields: Record<string, unknown>): void {
  const event = String(fields.hook_event_name ?? "");
  const transcript = typeof fields.transcript_path === "string" ? fields.transcript_path : "";
  if (event === "UserPromptSubmit") {
    for (const name of COUNTED) writeFileSync(join(dir, `${name}.count`), "0");
  }
  const line = {
    event,
    session: fields.session_id,
    transcript,
    promptId: fields.prompt_id,
    active: fields.stop_hook_active,
    text: fields.last_assistant_message,
    bytes: transcript !== "" && existsSync(transcript) ? statSync(transcript).size : 0,
  };
  appendFileSync(join(dir, "hooks.jsonl"), `${JSON.stringify(line)}\n`);
}

function act(): void {
  const only = join(dir, "only");
  if (existsSync(only) && readFileSync(only, "utf8").trim() !== behavior) return;
  if (behavior === "crash") {
    console.error("throwaway test hook crashed");
    process.exit(1);
  }
  if (behavior === "prevent") {
    console.log(JSON.stringify({ continue: false, stopReason: "Throwaway test hook: stop here." }));
    return;
  }
  const file = join(dir, `${behavior}.count`);
  const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  writeFileSync(file, String(count + 1));
  if (count >= (behavior === "block2" ? 2 : 1)) return;
  const output =
    behavior === "context"
      ? { hookSpecificOutput: { hookEventName: "Stop", additionalContext: REASON } }
      : { decision: "block", reason: behavior === "slow" ? SLOW : REASON };
  console.log(JSON.stringify(output));
}
