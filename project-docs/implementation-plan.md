# Claude Code ↔ Telegram: Implementation Plan

Status: rev. 11 (4.2: plans reviewed from the phone, approved at the Mac, F20; rev. 10: 4.2 chosen, phase 5
on, O2 decided as D9; rev. 9: 3.4, Markdown in the chat; rev. 8, §1: steps follow on their own, Codex
reviews paused; rev. 7: O1 decided: D8; rev. 6: Codex review of rev. 5, finish detection by the stop's
continuation entries, proven in 2.8, SIGTERM per waiter) · 2026-09-29 · Repo:
`/Users/hamed/src/bc/claude_telegram_integration`

What we build and why is in [design.md](design.md): the goal, platform facts (F1–F20), architecture and
flows 1–4, decisions (D1–D9, open O3), security, rollback, risks and the review log. References such as
"flow 3", "D6" or "F13" below point there. This file is the order of work.

## 1. How we work

- One step at a time. Each step ends with a check you can see. Since step 2.6 (your call, 2026-09-28) a
  step that passes is committed and the next one starts on its own; the work stops only where you have
  to act: a live check at the Mac or on your phone, a change to `~/.claude/settings.json`, or a decision
  that is yours.
- After each step, `project-docs/progress.md` records the step, date, result, the evidence line and what
  we learned, so a new session can pick up from there.
- Hooks in `~/.claude/settings.json` apply to every Claude session on this Mac. Until you widen it at the
  phase 2 checkpoint, everything we install acts only for sessions started in `<repo>/sandbox/`, never for
  the session doing the build or your other work.
- Strict TypeScript with no `any`; files ≤ 300 lines, functions ≤ 50; an `unhandledRejection` handler in
  every entry point; no silent catches (log with context).
- A step is done only when `bun run typecheck`, `bun run lint` and `bun test` pass and its live check
  passes.
- Codex reviews are paused until the project is done; then you decide whether to run one (your call,
  2026-09-28).

## 2. Steps

### Phase 0: Prerequisites (you, ~10 min)

- **0.1** Create the bot: BotFather → `/newbot`. Keep the token for `.env` in step 2.1; never paste it
  into chat or git.
- **0.2** Turn on Telegram two-step verification: whoever controls your Telegram account will be able to
  drive Claude on this Mac.
- **0.3** Answer O3, and decide how the Mac stays awake (D6).

### Phase 1: Scaffold, then prove the risky parts

- **1.1 Scaffold.** `git init`; `.gitignore` (`.env`, `.env.*`, `.state/`, `sandbox/`, `node_modules/`,
  `dist/`, `CLAUDE.local.md`), `.dockerignore`, `.env.example`, strict `tsconfig.json`, `biome.json`,
  `package.json` scripts (`typecheck`, `lint`, `test`), folders `src/ tests/ scripts/ sandbox/ .claude/`,
  `project-docs/progress.md`, and a `CLAUDE.md` that holds the rules of §1 so every session follows them.
  **Pass:** `bun run typecheck`, `bun run lint` and `bun test` all exit 0 (one smoke test).
- **1.2 Spike S1: wake an idle VS Code session.** A throwaway Stop hook (`asyncRewake`, timeout 900)
  exits at once unless the session's cwd is inside `sandbox/`; there it sleeps 60 s, then exits 2 with
  "SPIKE: reply with the word PONG". Settings are backed up first. You test in a second VS Code window
  opened on `sandbox/`, whose `.claude/settings.json` excludes `<repo>/CLAUDE.md` (`claudeMdExcludes`),
  so the test session sees only your global CLAUDE.md, as a session in any other repo would.
  **Pass:** about 60 s after a turn ends, the idle panel wakes by itself and Claude answers PONG, and
  the panel stays usable during the wait.

  **Also record:**
  - how the reminder reads to Claude, and whether Claude follows it as your instruction;
  - whether 10 wakes in a row work (8-cap);
  - what happens if the hook exits 2 while Claude is busy with a new prompt;
  - what happens to the hook process when the panel closes;
  - whether `timeout: 43200` is accepted;
  - how much memory one waiting hook uses.
- **1.3 Spike S2: answer a question from a hook.** A `PreToolUse` hook on `AskUserQuestion`, limited to
  `sandbox/` sessions, returns allow + answers (first option, then a free-text answer). **Pass:** no local
  dialog appears and Claude reports the injected answer, in the VS Code panel and in a terminal session.
- **1.4 Spike S3: record real inputs.** A logging hook, again limited to `sandbox/` sessions, saves stdin
  (redacted) and `CLAUDE_CODE_ENTRYPOINT` for each event from the VS Code panel, a terminal session and
  `claude -p`, as test fixtures. **Pass:**
  - fixtures exist for every event in the hook table (design §3);
  - we know whether `PermissionRequest` and `idle_prompt` fire in the VS Code panel, and when;
  - we know how much a sync `UserPromptSubmit` delays sending a prompt.
- **1.5 Findings.** Remove only the spike entries (settings byte-identical to the backup if nothing else
  changed meanwhile) and write `project-docs/spike-findings.md`. If a spike failed, update the design:
  - S1 fails → blocking Stop hook with a raised cap, released when you return to the keyboard.
  - S2 fails → deny the tool call, with your answer as the reason.
  - No `idle_prompt` in the panel → a pass-through wrapper around the Codex checkpoint hook that reports
    whether it blocked. This needs your OK, because it changes that hook's settings entry.

  **Go/no-go with you.** Done 2026-09-28: all three spikes passed. `idle_prompt` never fires in the
  panel, and you chose to read each stop's summary (F16) instead of the wrapper; see
  [spike-findings.md](spike-findings.md).

### Phase 2: Notifications (Telegram pings you; no replies yet)

- **2.1 Config and secrets.** `.env` in `<repo>` holds the token (0600) and is loaded explicitly.
  `config.json` holds the presence thresholds, the folders to serve (only `sandbox/` until the phase 2
  checkpoint), which entrypoints to serve, repos to skip, and the content policy. Folders and skips are
  matched against the session's start directory, `CLAUDE_PROJECT_DIR` (F15). **Pass:** tests show a
  missing or invalid token produces a clear error that never prints the token.
- **2.2 Telegram client.** `getMe`, `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`,
  `sendDocument`; honours 429 `retry_after`. The token is part of every API URL, so it is scrubbed from
  logs and errors. **Pass:** tests against a local fake Bot API server show the retry is honoured and the
  token appears in no log line.
- **2.3 Broker skeleton.** Unix-socket server, single-instance lock, SQLite schema, `/health`, the disabled
  flag; `ctl start|stop|status|disable|enable`. **Pass:**
  - starting it twice leaves one process, and health is OK;
  - a killed broker is restarted by the next hook, but not while disabled;
  - sessions in two unrelated repos, one with a `.env` that sets `TELEGRAM_BOT_TOKEN` and a `bunfig.toml`
    with a `preload`, reach the same broker; it uses this repo's token, and none of that repo's code
    runs (F13, F14).
- **2.4 Pairing.** `ctl pair` prints a one-time code (valid 10 min). You send `/pair <code>` to the bot,
  and from then on only your Telegram user id is accepted, in a private chat; everything else is dropped
  and logged. **Pass:** tests reject a wrong or expired code, another user and a group chat; live, the
  bot answers "Paired ✅".
- **2.5 Formatter (O1, decided: D8).** Redaction covers private keys, JWTs, Telegram bot tokens, `sk-`, `AKIA`,
  `AIza`, `glpat-`, `ghp_`, `xox*-`, bearer tokens and `KEY=value` lines with secret-looking names. Its
  patterns don't rely on `\b`: a bot token follows `bot` directly in API URLs and may end in `-`, and
  `sk-` must not match inside `task-notification`. Plus HTML escaping, 4096-char chunks, and the cap with
  the full text as a file. **Pass:** a fixture with one sample of each secret family, including a token
  inside a Bot API URL, comes out with none surviving, and no chunk exceeds 4096 characters.
- **2.6 Presence.** Parse the real `ioreg` output (nanoseconds → seconds) every 5 s, check the screen
  lock, and handle `/away` `/auto` `/off` `/status`. **Pass:**
  - parser tests on recorded `ioreg` output, with boundaries at 29/30 s and 179/180 s;
  - a missing value counts as present and shows as "unknown";
  - live, locking the screen makes `/status` say away within 10 s.
- **2.7 Notify hooks + install.** SessionStart (with the one-line note), UserPromptSubmit (cancel
  barrier), Stop (waiter, notify only for now; a real finish is told from a continuation by the stop's
  transcript entries, F16, proven in 2.8),
  Notification (`idle_prompt`, terminal only), PermissionRequest (async 🔐 ping, skipping
  `AskUserQuestion`), StopFailure, the `AskUserQuestion` ping, SessionEnd.
  - Skipped: subagents (`agent_id` set), entrypoints not served (per S3), repos in the skip list. Running
    background tasks are listed in the message, never a reason to skip.
  - `ctl install` backs up settings, adds tagged entries idempotently and writes atomically. The entries
    call Bun by absolute path, because the VS Code extension's `PATH` may not include `~/.bun/bin`, with
    `--no-env-file --config=<repo>/bunfig.toml` (F13, F14).
    `ctl uninstall` removes only those entries.

  **Pass:**
  - Installing twice leaves one set of entries.
  - Uninstalling removes only ours and keeps a settings edit you made after install.
  - Live, in a new `sandbox/` session with `/away` on: "say hi" reaches Telegram, while the build session
    and your other sessions send nothing, including a session started elsewhere that `cd`s into
    `sandbox/` (F15).
  - At the keyboard with `/auto`: nothing is sent.
  - With a dev server left running in the background, the ✅ still arrives and lists it.
- **2.8 Finish detection and the Codex hook.** The Stop waiter classifies each stop from its transcript
  entries (F16, flow 1), so the Codex hook's settings entry stays untouched. Proven here, before the
  checkpoint widens the served folders. **Pass:**
  - tests on recorded transcript sequences: a stop blocked by a hook, a hook continuing via
    `additionalContext`, a Stop hook that crashes (non-blocking error), blocked-then-final, a summary
    written before the waiter started, a partial last line, identical final texts in two turns, and a
    cancel before the notification;
  - live in `sandbox/`, with throwaway Stop hooks for the block, the `additionalContext` and the crash:
    exactly one ✅, only after the real finish;
  - live, change a file during the session (the Codex hook ignores changes made before the session
    started): you get the Codex question first and exactly one ✅ after the real finish, even when
    Claude's continuation takes longer than 20 s.
- **Checkpoint:** you choose which folders to serve beyond `sandbox/` (all, or a list); then a day of
  notify-only use, and you tell me what is noisy.

### Phase 3: Reply from Telegram to continue

- **3.1 Waiter protocol.** Waiters get a generation per session; cancelling and delivering compete as in
  flow 2.
  - The hook confirms receipt to the broker before exiting 2; an unconfirmed hand-over is reported to
    you, never resent.
  - If the broker is down, the cancel is written to disk and applied before the broker accepts replies.
  - With the disabled flag, waiters exit with no decision.
  - A waiter exits if its parent Claude process dies, and reconnects if the broker restarts.
  - On SIGTERM (panel closed, timeout) a waiter reports the end of its own generation, then exits with no
    decision (S1). The broker marks the session as not listening only when no newer waiter of it is
    live. If the broker is down, the end is written to disk like a cancel, and at start the broker also
    drops waiters whose Claude process is gone.

  **Pass:** tests cover:
  - both race orders (typed first, reply first);
  - a late cancel that must not hit a newer waiter;
  - an old waiter ending after its replacement registered, which leaves the session listening;
  - a waiter ending while the broker is down;
  - a broker crash at each boundary: after fetching an update, after storing it, after handing it over.
- **3.2 Routing and queue**, as in flow 4. **Pass:** tests for reply-to, the single waiting session, the
  picker, nobody listening, queued-while-busy, a repeated `update_id`, and an answer for an expired request.
- **3.3 Live.** **Pass:**
  - "now say bye" sent from Telegram → the VS Code session continues and answers;
  - 10 round-trips in a row work;
  - typing locally mid-wait edits the Telegram message to "↩️ continued at the computer" and injects
    nothing.
- **3.4 Claude's Markdown in Telegram** (D8, decided with you at the phase 2 checkpoint, 2026-09-29).
  The chat renders bold, italics, code, code blocks, tables and web links; file names and paths are
  code. **Pass:** tests that every message's tags nest and fit, for tricky Markdown and oversized code or
  lines; markup Telegram refuses goes again as plain text; live, a Markdown-rich ✅ arrives formatted.

### Phase 4: Answer Claude's questions from Telegram

- **4.1 Relay `AskUserQuestion`** with the three presence states of flow 3. One message per question:
  - options are buttons (`callback_data` ≤ 64 bytes: request id + index), and a text reply is your own
    answer;
  - multi-select uses toggles + Submit, and the answer goes back as one string joined with `", "` (F4);
  - `text` questions take the reply as typed, `number` questions a number within `min`–`max`;
  - `/local` hands the question back to the local dialog.

  **Pass:**
  - tests for single, multi (one joined string), free text, text and number questions, a stale button →
    "expired", and an in-between hold released by input;
  - live, you answer the Codex checkpoint question from your phone;
  - live, leaving while a question is open locally gets you a "waiting at the computer" message.
- **4.2 (optional; you chose it on 2026-09-29)** `ExitPlanMode`: the plan in the chat, the way of flow 3,
  with its `.md` file when long. No hook can approve a plan (F20, found live), so from the phone you can
  only send it back for more planning: Keep planning, or a reply with what to change; it is approved in
  its dialog at the Mac (your choice, 2026-09-29). **Pass:** tests for Keep planning and your words
  (denied with them), a plan read from its file, "🖥 Approve at the Mac", and one left open at the Mac;
  live, a reply from your phone sends a sandbox plan back for more planning, and the next plan is
  approved at the Mac.

### Phase 5: Permission approvals (O2 = yes: D9, decided 2026-09-29)

- **5.1 Relay `PermissionRequest` per the tool policy**, with the presence states of flow 3. Never for
  `AskUserQuestion`, whose dialog is also a permission request (F5); 4.1 handles it.
  - The message shows the complete operation: the whole Bash command and its cwd, or the file path and
    the full change for Edit/Write. Long ones are split over several messages or sent as a file, never
    shortened.
  - Allow once / Deny / Deny with a reason; the buttons are bound to that request and a hash of what you
    were shown. Never "always allow" from Telegram, and every decision goes to the audit log.
  - If the repo's content policy (D8) is ping-only, approvals stay local.

  **Pass:**
  - a tool outside the policy gets the local dialog only;
  - a very long command arrives complete;
  - a button press from another account is ignored;
  - a timeout means no decision;
  - live, you approve `npm test` from your phone.

### Phase 6: Hardening and handover

- **6.1** `README.md` (setup, pairing, commands, uninstall), `ctl doctor` (token valid via `getMe`,
  broker up, socket permissions, hooks installed, Bun path, the stop summary still readable, F16), log
  rotation, and the uninstall order of
  design §6. **Pass:** uninstall works while a Stop waiter, a held question and a permission request are
  all active, after a settings edit made since install.
- **6.2** Full gate: `typecheck`, `lint` and `test` with their summary lines, plus the Codex code-review
  checkpoint.

Later, if wanted: a Telegram topic per session, `/new <repo> <prompt>` to start a headless session,
resuming ended sessions, steering Claude mid-turn, packaging as a Claude Code plugin.
