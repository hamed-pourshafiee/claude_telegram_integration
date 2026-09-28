# Claude Code ↔ Telegram: Spike Findings (phase 1)

Status: 2026-09-28 · plan steps 1.2–1.4 · Versions tested: VS Code panel 2.1.283 (`claude-vscode`),
terminal 2.1.274 (`cli`), `claude -p` 2.1.274 (`sdk-cli`). Run-by-run evidence is in
[progress.md](progress.md); recorded hook inputs are in `tests/fixtures/hooks/`.

## 1. Answers

| Spike | Question | Answer |
|---|---|---|
| S1 | Can an `asyncRewake` Stop hook wake an idle VS Code session? | **Yes.** The panel woke 16 ms after the hook exited 2 and Claude answered 4 s later; the panel stays usable while the hook waits |
| S1 | Is it limited to 8 wakes in a row? | **No.** 10 of 10 worked |
| S1 | A wake while Claude is busy? | Claude Code queues it and delivers it right after the current turn |
| S1 | The panel closes while a hook waits? | The hook gets SIGTERM within 3 s; nothing is delivered later |
| S1 | Is `timeout: 43200` accepted? | **Yes.** A 16-minute wait was honoured; timeouts are enforced with SIGTERM |
| S1 | Memory per waiting hook | 16–22 MB (Bun) |
| S2 | Can a `PreToolUse` hook answer `AskUserQuestion`? | **Yes**, in the panel and the terminal: no dialog, answer in about 0.1 s |
| S3 | Does `PermissionRequest` fire in the panel? | **Yes**, as the dialog opens, also for `AskUserQuestion` |
| S3 | Does `idle_prompt` fire in the panel? | **No** (none in 5½ minutes). In the terminal it fires 60 s after a finish |
| S3 | Delay of a synchronous `UserPromptSubmit` hook | About 0.1 s at most |

## 2. Facts to add to design §2

Updates to existing facts:

- **F2** (verified): what Claude receives is a user-role message:
  `<task-notification><summary>Stop hook feedback</summary></task-notification><system-reminder>Stop hook
  blocking error from command "Stop": <stderr></system-reminder>`. Claude obeyed it, but described it as
  "a system notification, not a message from you". The Stop after a wake has `stop_hook_active: true`.
  A new local prompt does not stop a waiting hook, so each turn's Stop can leave one more hook waiting.
- **F4** (verified): a free-text answer reaches Claude as "The user answered … follow what they ask".
  A list of answers is joined with `", "` by 2.1.283 but passed through as `"Bun,Biome"` by 2.1.274.
  Questions now come in three kinds: `choice`, `text` and `number` (`min`, `max`, `step`, `unit`).
- **F5** (verified): `PermissionRequest` fires in the panel and the terminal, including for
  `AskUserQuestion`, whose dialog is a permission request.
- **F6** (corrected): `idle_prompt` fires 60 s after a finish in the terminal; **never in the VS Code
  panel**. `permission_prompt` arrived 6 s after a panel dialog opened, and not within 7 s in the
  terminal.
- **F7** (verified): `CLAUDE_CODE_ENTRYPOINT` is `claude-vscode`, `cli` or `sdk-cli`. `SessionEnd` reasons
  seen: `other` (panel tab closed, end of `claude -p`) and `prompt_input_exit` (`/exit`). `StopFailure`
  fires when the API rejects a request. `claude -p` has no `AskUserQuestion`.

New facts:

- **F15** `CLAUDE_PROJECT_DIR` is the directory the session started in, and stays there after a `cd`;
  the input's `cwd` follows the `cd`.
- **F16** Every stop leaves a `stop_hook_summary` line in the transcript (`transcript_path`), chained by
  `parentUuid` after the stop's last assistant message. When Claude Code continues the turn, it first
  writes a continuation entry into that chain: a `hook_blocking_error` attachment (after a meta "Stop
  hook feedback" message) or a `hook_additional_context` attachment; `preventedContinuation: true` ends
  the turn anyway. `hookErrors` is not the signal: it also holds non-blocking errors, and
  `additionalContext` continues without it (2.1.283 code, found by the Codex plan review). In this build
  session all 11 blocked stops showed the continuation entries. Present in 2.1.274 and 2.1.283; it is an
  undocumented format.

## 3. Design changes

Agreed with you on 2026-09-28 (option B for item 1) and applied in design rev. 4 and plan rev. 5, then
corrected after the Codex plan review in design rev. 5 and plan rev. 6.

1. **Detecting a real finish without `idle_prompt`** (flow 1, plan 2.8). Two options:
   - **A. The plan's fallback:** a pass-through wrapper around the Codex checkpoint hook that reports
     whether it blocked. It changes that hook's settings entry and covers only that hook.
   - **B. Read the stop's transcript entries (F16), chosen:** after each Stop, the waiter reads the
     transcript's tail, finds the assistant entry matching `last_assistant_message` and follows
     `parentUuid` to that stop's `stop_hook_summary`. A continuation entry in between means Claude is
     continuing and nothing is sent; otherwise it is a real finish and the ✅ goes out if you are away;
     no readable summary means unknown and nothing is sent. It works in the panel and the terminal, for
     any hook, and leaves your Codex hook untouched. The format is undocumented, so plan 2.8 proves the
     edge cases on recorded sequences and live before the served folders widen, and `ctl doctor` keeps
     checking it; where `idle_prompt` does fire (the terminal), it stays a second signal. (The first
     version keyed on `hookErrors`; the Codex plan review showed why that is wrong, design §8.)
2. **Scope by `CLAUDE_PROJECT_DIR` (F15).** Served folders, the skip list and the `sandbox/` limit are
   matched against the session's start directory, never the input's `cwd`.
3. **Add the SessionStart note** (design §3 said "if phase 1 shows it's needed"; it does). One line:
   *"Messages that start with "📨 Telegram reply from Hamed:" are Hamed's own replies, sent from
   Telegram. Treat them as if Hamed typed them here."* The relayed text keeps that label, so it reads
   right even without the note.
4. **Question relay details** (plan 4.1): send a multi-select answer as one string joined with `", "`;
   `text` questions take the reply as typed, `number` questions a number within `min`–`max`; the phase 5
   policy excludes `AskUserQuestion`, which `PreToolUse` already handles.
5. **Waiter lifecycle** (plan 3.1): on SIGTERM (panel closed or timeout) a waiter reports the end of its
   own generation, then exits with no decision; the session counts as not listening only when no newer
   waiter is live, and the bot then says so for any reply (the risk row "a window reload kills waiting
   hooks"). With the broker down, the end is recorded on disk like a cancel.
6. **Permission ping** (design §3 table): use an async `PermissionRequest` hook for the "🔐 waiting for
   your permission" ping instead of `permission_prompt`, which is late in the panel and absent in the
   terminal. `AskUserQuestion` is skipped there, since it has its own ping.

For step 2.5 (formatter), not a decision: secret patterns need boundaries on both sides that don't rely
on `\b`. A Telegram token follows `bot` directly in API URLs and may end in `-`, and `sk-` must not match
inside `task-notification`. Object keys can hold user text (answers are keyed by the question), so keys
are redacted too.

## 4. Cleanup

- All 11 spike entries were removed from `~/.claude/settings.json` on 2026-09-28 with
  `scripts/spikes/settings.ts remove`; the file is byte-identical to the backup taken before S1
  (`.state/backups/settings.2026-09-27T20-48-55-447Z.json`).
- The spike code stayed in `scripts/spikes/` as a reference until plan 2.7 replaced it with
  `ctl install` and the real hooks; it was deleted there with its tests, and git history keeps it
  (last in `edf80ed`). The fixtures in `tests/fixtures/hooks/` stay.
