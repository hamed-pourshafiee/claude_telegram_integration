# Progress

The log of [implementation-plan.md](implementation-plan.md), newest step last. Each entry records the
date, the result, the evidence and what we learned. A new session reads this, then continues at **Next**.

## Phase 0: prerequisites (the user)

| Item | Status |
|---|---|
| 0.1 Bot created with BotFather | done (2026-09-28); the user keeps the token, it goes into `.env` at 2.1 |
| 0.2 Telegram two-step verification | on (2026-09-28) |
| 0.3 O3 git remote | local only for now (2026-09-27) |
| 0.3 D6 how the Mac stays awake | Amphetamine (2026-09-28) |

## 1.1 Scaffold

- **Date:** 2026-09-28
- **Result:** the gate passes. Waiting for the user's confirmation, then a local commit.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 4 files in 30ms. No fixes
  applied." exit 0 · `bun test` "12 pass, 0 fail, 13 expect() calls" exit 0. A probe file with a type
  error, an `any`, a floating promise, a 62-line function and 308 lines made all three exit 1, then was
  deleted. Codex review (`--uncommitted`, high effort): no actionable findings, and its own gate run was
  green (`~/.claude/codex-reviews/code-claude_telegram_integration-20260928-000242.md`).
- **Learned:**
  - Toolchain, pinned exactly: Bun 1.4.1, TypeScript 7.0.2 (native `tsc`), Biome 2.5.14,
    @types/bun 1.4.2.
  - Biome 2.5 deprecates `linter.rules.recommended`; the config uses `"preset": "recommended"`.
  - `.env.*` also matches `.env.example`, so `.gitignore` has `!.env.example`.
  - The npm registry is slow from here (about 50 KB/s): `bun install` took 438 s. Run it in the
    background and allow minutes.
  - The Codex checkpoint Stop hook (F11) also fired at a mid-step pause (waiting for the install), in a
    repo that did not exist at SessionStart. Relevant to step 2.8.
  - Beyond the plan's list, §1's size rules are now part of the gate: Biome's
    `noExcessiveLinesPerFunction` (max 50) and a test that fails on any `.ts` file over 300 lines.

Committed as `892b670` after the user's go (2026-09-28).

## 1.2 Spike S1: wake an idle VS Code session

- **Date:** 2026-09-28
- **Result:** passed. Waiting for the user's confirmation, then a local commit.
- **Evidence:** run A below: the idle panel woke 60.0 s after the turn and Claude answered PONG; the
  panel stayed usable. All six "also record" items are answered below. Gate: `bun run typecheck` exit 0
  · `bun run lint` "Checked 8 files … No fixes applied." · `bun test` "26 pass, 0 fail".
- **Prepared:** `scripts/spikes/` holds the hook (`s1-stop-rewake.ts`), shared helpers and a
  settings tool (`settings.ts show|backup|add|remove`); tests in `tests/spikes/`. Gate green (25 pass).
  Self-test without Claude: exit 2 with the PONG line after 2.2 s; a second stop in the same run is
  skipped; SIGTERM is logged and exits 0; a waiting hook uses about 16–19 MB RSS. Settings backed up to
  `.state/backups/settings.2026-09-27T20-48-55-447Z.json`. The user OKed the entry, F14 and the sandbox
  exclusion, and asked for a Codex review before the install. F14 is in design rev. 3 and plan rev. 4.
- **Codex review** (`code-claude_telegram_integration-20260928-002137.md`): one finding, confirmed and
  fixed. `remove` dropped a whole hook group when any hook in it was a spike, so a hook added later into
  that group would have gone too; it now filters single hooks (regression test added). Also added: the
  write aborts if `settings.json` changed after it was read. Gate green, 26 pass.
- **Installed 2026-09-28 00:24:** `settings.ts add s1`; backup
  `.state/backups/settings.2026-09-27T20-54-55-606Z.json`, byte-identical to the first one. The diff is
  exactly one group appended to `hooks.Stop`. `sandbox/.claude/settings.json` holds `claudeMdExcludes`.
  Run A armed in `.state/spikes/s1.json` (60 s, 1 wake).
- **Live runs, 2026-09-28** (VS Code panel 2.1.283, sandbox window; evidence in `.state/spikes/s1.log`
  and the sandbox transcripts under `~/.claude/projects/…-sandbox/`):
  - Isolation: the sandbox session loads only `~/.claude/CLAUDE.md`, in new conversations too.
  - **A** (60 s, 1 wake) **pass:** the hook fired at 60.0 s, the message reached the idle panel 16 ms
    later, PONG 3.8 s after that. The panel stayed usable: a prompt sent mid-wait was answered normally.
  - What Claude receives, as a user-role message: `<task-notification><summary>Stop hook feedback`
    `</summary></task-notification><system-reminder>Stop hook blocking error from command "Stop":`
    `<stderr></system-reminder>`. Claude obeyed, but said it came "as a system notification, not as a
    message from you", and read the spike script and settings.json to find the source. So the
    SessionStart note of design §3 looks needed; wording for 1.5.
  - A new local prompt does not cancel a waiting async Stop hook; every turn's Stop starts another one,
    so several can wait at once. The Stop after a wake has `stop_hook_active: true`.
  - **B** (5 s, 10 wakes) **pass:** 10 of 10 PONGs. The 8-in-a-row cap does not apply to asyncRewake.
    Wake to message ≤ 0.1 s, to PONG 2–4 s.
  - **C** (wake while busy) **pass:** the hook fired 11 s into a long turn; Claude Code queued the
    message and delivered it 0.2 s after the turn ended, without interrupting it. (First try: `sleep 60`
    went to the background because foreground sleep is blocked; a wake during a background task arrives
    at once, and the Stop input's `background_tasks` then has 1 entry.)
  - **D** (panel closed mid-wait): the session's `claude` process exited and sent the hook SIGTERM
    within 3 s; nothing was delivered later. Phase 3: on SIGTERM the waiter must tell the broker that
    the session stopped listening.
  - **E1** (timeout 30, wait 60, new conversation): SIGTERM at 30.0 s, no wake, no notice in the
    transcript. The timeout is enforced, with SIGTERM.
  - **E2** (timeout 43200, wait 960 s, new conversation) **pass:** the hook waited 960.0 s, past the
    600 s default and the old 900 s, then woke the session; PONG 4 s later. RSS grew from 16 to 21.5 MB
    over the 16 minutes (the spike spawns `ps` every 15 s).
  - Static, from the 2.1.283 binary: `timeout` is `number().positive()` with no maximum, and an async
    hook's timeout is `timeout × 1000` ms with no clamp. Undocumented `@internal` fields
    `rewakeMessage` (prefix shown to the model) and `rewakeSummary` exist; the design must not rely on
    them.
  - Memory: a waiting Bun hook uses 16–22 MB RSS, as a direct child of the panel's `claude` process.
  - Stop input keys in 2.1.283 add `effort`, `prompt_id`, `scratchpad_dir` and `session_crons` to F1.
  - Settings backups before the E edits: `.state/backups/settings.2026-09-27T22-25-56-445Z.json`
    (900→30) and `settings.2026-09-27T22-54-29-891Z.json` (30→43200). The live entry has 43200.
  - The sandbox Claude infers the project from its path (`…/claude_telegram_integration/sandbox`);
    no CLAUDE.md or memory of ours reaches it.
  - For step 2.5: the pre-commit scan's `sk-[A-Za-z0-9]{10,}` matched `task-notification`. Secret
    patterns need a boundary before the prefix.
- **After the runs:** S1 is disarmed (`maxWakes: 0` in `.state/spikes/s1.json`) so it can't wake the
  1.3/1.4 sandbox sessions. Its settings entry stays until 1.5 removes all spike entries.
- **Found:** Bun loads `bunfig.toml` from the session's directory and runs its `preload`, even with
  `--no-env-file`. `--config=<repo>/bunfig.toml` prevents it; a missing `--config` file stops Bun with
  exit 1. Proposed as design F14.
- **Found:** a session in `sandbox/` would also load `<repo>/CLAUDE.md`, which sends it to the build
  docs, and they describe this spike. Proposed: `sandbox/.claude/settings.json` with `claudeMdExcludes`.

Committed as `dc9b0e8` after the user's go (2026-09-28).

## 1.3 Spike S2: answer a question from a hook

- **Date:** 2026-09-28
- **Result:** passed. Waiting for the user's confirmation, then a local commit.
- **Evidence:** no local dialog, and Claude reported the injected answer (an option and free text) in
  the VS Code panel (2.1.283) and in a terminal (`claude` 2.1.274, entrypoint `cli`). Gate:
  `bun run typecheck` exit 0 · `bun run lint` "Checked 10 files … No fixes applied." · `bun test`
  "32 pass, 0 fail". Codex review (`code-claude_telegram_integration-20260928-040144.md`): no
  actionable findings.
- **Prepared:** `scripts/spikes/s2-answer-question.ts`, a `PreToolUse` hook on
  `AskUserQuestion`; `.state/spikes/s2.json` picks the mode (`first`, `multi`, `text`, `off`). Tests in
  `tests/spikes/s2.test.ts`; gate green (32 pass). Self-test without Claude: each mode prints `allow`
  with the expected `updatedInput.answers`; `off` prints nothing.
- **From the 2.1.283 binary:** `answers` is `record<question text, string | string[]>`, and a list is
  joined with `", "` (F4's comma rule). Question texts must be unique, and option labels unique within a
  question. New question kinds: `choice` (default), `text` (free-text box, `placeholder`) and `number`
  (`min`, `max`, `step`, `defaultValue`, `unit`), plus per-question `description` and `annotations`
  (`preview`, `notes`). Phase 4 must handle text and number questions.
- **Installed 2026-09-28 04:03 (local):** `settings.ts add s2`; backup
  `.state/backups/settings.2026-09-28T00-33-13-287Z.json`. The diff is exactly one group appended to
  `hooks.PreToolUse`.
- **Live runs** (evidence in `.state/spikes/s2.log` and the sandbox transcripts):
  - Panel, `first`: the answer arrived 100 ms after the question; Claude got "Red". The tool result
    reads like a local answer: `Your questions have been answered: "…"="Red". You can now continue…`.
  - Panel, `text`: 114 ms; Claude got "Purple, typed on my phone" and took it for the user's own
    "Other" answer. Free text comes with another wrapper: `The user answered: "…"="…". Read the answers
    carefully — they may request clarification, changes, or that you not proceed — and follow what they
    ask`, so Claude treats it as the user's instruction.
  - Terminal, `first` and `text`: the same, 114 ms; the CLI shows "User answered Claude's questions:
    · … → Red".
  - Terminal, `multi` (optional): Claude got the list as "Bun,Biome". 2.1.274 passes a list through and
    joins it with "," and no space, where 2.1.283's schema joins with ", ". Phase 4 must send one string
    it joins itself with ", ", never a list.
  - `PreToolUse` input keys: `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`,
    `scratchpad_dir`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`.
- **After the runs:** S2 is `off` (`.state/spikes/s2.json`), so 1.4's sessions see normal dialogs. Its
  settings entry stays until 1.5.

Committed as `6234b4e` after the user's go (2026-09-28).

## 1.4 Spike S3: record real hook inputs

- **Date:** 2026-09-28
- **Result:** passed. Waiting for the user's confirmation, then a local commit.
- **Evidence:** 25 fixtures in `tests/fixtures/hooks/` (panel 9, terminal 9, `claude -p` 7) cover every
  event of design §3's table; `tests/fixtures.test.ts` checks names, redaction and coverage. Gate:
  `bun run typecheck` exit 0 · `bun run lint` "Checked 13 files … No fixes applied." · `bun test`
  "68 pass, 0 fail". Codex review (`code-claude_telegram_integration-20260928-050742.md`): two redaction
  gaps, both confirmed and fixed with regression tests: Telegram tokens inside Bot API URLs
  (`…/bot<TOKEN>/…`, no word boundary) or ending in `-`, and object keys (answers are keyed by question).
- **Prepared:** `scripts/spikes/s3-record.ts` saves each event's stdin, redacted (home path
  to `~`, secret families masked, strings capped at 4,000 characters), to
  `.state/spikes/s3/<entrypoint>/`, and a summary line to `.state/spikes/s3.log`. The settings tool now
  holds a list of entries per spike; S3 has nine, one per event of design §3's table, all async except
  `UserPromptSubmit` (to measure the delay) and `SessionEnd`. Tests in `tests/spikes/s3.test.ts`; gate
  green (39 pass). Self-test: redaction works; a Bun hook that exits at once takes about 17 ms from spawn
  to exit (16–22 ms over 10 runs).
- All nine event names are in the 2.1.283 settings schema, and `StopFailure` is in the 2.1.274 binary.
- The user OKed the entries and the `claude -p` runs, and asked for a Codex review before the install.
- **Installed 2026-09-28 04:41 (local):** `settings.ts add s3`, nine groups; backup
  `.state/backups/settings.2026-09-28T01-41-00-539Z.json`.
- **Results** (raw records in `.state/spikes/s3/` and `s3.log`):
  - `idle_prompt` fires in the terminal (2.1.274) 60.2 s after a Stop, but **never in the VS Code
    panel** (2.1.283): none in 5½ minutes idle, while other notifications arrived. Plan 1.5's
    contingency applies: a wrapper around the Codex hook, which needs the user's OK.
  - `PermissionRequest` fires in the panel and the terminal as the dialog opens, for Bash and also for
    `AskUserQuestion`, whose dialog is a permission request.
  - `permission_prompt` notification: in the panel 6 s after a dialog opened and was still unanswered;
    in the terminal none with a dialog open about 7 s.
  - Sync `UserPromptSubmit`: the prompt entered the transcript 19–63 ms after Enter and our hook had
    finished by 84–170 ms (its process 9–82 ms); a Bun hook that exits at once takes about 17 ms. A sync
    barrier adds about 0.1 s at most.
  - `StopFailure` fires when the API rejects a request (`claude -p --model not-a-real-model`):
    SessionStart → UserPromptSubmit → StopFailure → SessionEnd.
  - `SessionEnd` reasons: `other` (panel tab closed; end of `claude -p`), `prompt_input_exit` (`/exit`).
  - `CLAUDE_CODE_ENTRYPOINT`: `claude-vscode` (panel), `cli` (terminal), `sdk-cli` (`claude -p`).
  - `claude -p` has no `AskUserQuestion`; in the user's auto mode `ls` ran without a PermissionRequest.
  - Scoping: a session started in the repo root that ran `cd sandbox` was then treated as a sandbox
    session (its later inputs carry `cwd` in `sandbox/`), while `CLAUDE_PROJECT_DIR` stayed at the repo
    root. The real hooks must decide what to serve by `CLAUDE_PROJECT_DIR`, not by `cwd` (F15, for 1.5).
  - Transcripts record the duration of sync SessionStart and Stop hooks (the Codex checkpoint takes
    113–130 ms per stop), not of UserPromptSubmit.
  - Biome skips `tests/fixtures/`, so recorded data stays as recorded.
- **After:** S3 stays installed until 1.5 removes all spike entries; it records only sandbox sessions.

Committed as `6133dd7` after the user's go (2026-09-28).

## 1.5 Findings and go/no-go

- **Date:** 2026-09-28
- **Result:** go/no-go done; all three spikes passed. The Codex plan review found three real problems in
  the first version of the changes, all fixed. Waiting for the user's confirmation, then a local commit.
- **Evidence:** [spike-findings.md](spike-findings.md). Spike entries removed with `settings.ts remove`:
  "now byte-identical to backup settings.2026-09-27T20-48-55-447Z.json", confirmed by `cmp`; no spike
  references left in settings.json and no spike processes running.
- **Decisions (the user, 2026-09-28):** remove the spike entries; detect a real finish by reading the
  stop's `stop_hook_summary` (F16, option B) instead of wrapping the Codex hook; apply the other changes
  (F2 and F4–F7 updated, F15 and F16 new, scoping by `CLAUDE_PROJECT_DIR`, the SessionStart note, the
  question-relay details, the waiter on SIGTERM, the 🔐 ping on `PermissionRequest`); a Codex plan
  review of the edits.
- **Docs:** design rev. 5, plan rev. 6, CLAUDE.md now says F1–F16. The plan's 2.5 list now names
  Telegram bot tokens, which it had missed.
- **Codex plan review** (`~/.claude/codex-reviews/plan----20260928-054822.md`): UNSOUND, 3 findings, all
  confirmed and fixed in design rev. 5 and plan rev. 6 (design §8):
  1. `hookErrors` also holds non-blocking errors, and `additionalContext` continues without it (checked
     in the 2.1.283 code). The rule now reads Claude Code's own continuation entries in the stop's
     chain (`hook_blocking_error`, `hook_additional_context`), with `preventedContinuation` and an
     "unknown" result that sends nothing.
  2. No rule said which summary belongs to which stop. Now: tail read, match `last_assistant_message`,
     follow `parentUuid`.
  3. SIGTERM ends only that waiter's generation; the broker marks a session as not listening only when
     no newer waiter is live.
- **Decision (the user):** the edge cases are proven in phase 2 as pass checks of 2.8 (recorded
  transcript sequences, plus live checks with throwaway Stop hooks), before the served folders widen.
- **Learned:** in this build session's transcript, all 11 blocked stops show the chain assistant → meta
  "Stop hook feedback" → `hook_blocking_error` attachment → summary, and Claude continued; a real finish
  is assistant → summary directly. The terminal (2.1.274) writes the same `stop_hook_summary`.
- The spike code stays in `scripts/spikes/` as a reference until 2.7 replaces it, then it goes with its
  tests; the fixtures stay.

Committed as `014439b` after the user's go (2026-09-28).

## 2.1 Config and secrets

- **Date:** 2026-09-28
- **Result:** passed: the gate and the live check. Waiting for the user's confirmation, then a local
  commit.
- **Live check (the user, 2026-09-28):** the user put the token into `.env` with the hidden-input
  command, then ran `bun run ctl doctor`: all seven lines ✓, the last "✓ .env private to you;
  TELEGRAM_BOT_TOKEN is shaped right (not shown)". The token never appeared on screen or in the chat.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 27 files … No fixes applied." ·
  `bun test` "158 pass, 0 fail" (after the Codex fix below).
  - The pass check's tests (`tests/shared/env.test.ts`, `tests/ctl/doctor.test.ts`) cover:
    - no `.env`, a mode other users can read, a folder;
    - no key, an empty value, the token on its own line;
    - spaces, quotes, no colon, letters before the colon, a cut-off token, the key twice.

    Each gives an error that says how to fix it, and no error or doctor line holds any 8-character
    piece of the token.
  - Positive control: making the error include the first 20 characters of the value failed 5 tests.
  - `bun run ctl doctor` before `.env` existed: "✗ .env No .env file at …", exit 1. `.env` was then
    created from the template with `umask 077`; `stat` shows mode 600 and `cmp` shows it equals the
    template. It was never read. The doctor now says "✗ .env TELEGRAM_BOT_TOKEN in .env is empty.
    Paste the token after the = sign.", exit 1.
- **Built:**
  - `src/shared/env.ts` reads the token only from `<repo>/.env`, never from `process.env` (F13), and
    refuses a `.env` that other users can read. It returns a `Secret` (`src/shared/secret.ts`) that
    prints as "[secret]" through `String()`, templates, JSON and `console.log`; only `reveal()` gives
    the value.
  - `src/shared/config.ts` reads `config.json`. Every setting is optional and the defaults fill in;
    unknown or wrong settings are refused by name. Relative paths are under the repo, `~/` under home.
  - `src/shared/scope.ts`: a session is served when its entrypoint is served and its
    `CLAUDE_PROJECT_DIR`, symlinks resolved, is inside a served folder and not in a skipped one. The
    recorded session that `cd`'d into `sandbox/` is not served (F15). A start folder that no longer
    exists is not served. `contentModeFor` applies the content policy.
  - `src/ctl/main.ts` with `ctl doctor`, which plan 6.1 grows: it shows the settings in effect and
    whether `.env` holds a well-formed token, without showing the token.
  - `bunfig.toml` has `env = false`.
- **Decisions (mine, open to change):**
  - `config.json` is gitignored, since it will name your folders. `config.example.json` is committed,
    and a test keeps it equal to the defaults. Without `config.json` the defaults apply.
  - Defaults:
    - serve `sandbox/` only;
    - entrypoints `claude-vscode` and `cli`, not `sdk-cli`: `claude -p` runs are scripted, with nobody
      to reply;
    - presence 30 s / 180 s (D4);
    - content `ping-only` until O1 is decided at 2.5.
  - `ctl doctor` starts now, because it is the only way to check the token without showing it.
- **Decisions (the user, 2026-09-28):** Codex reviews 2.1 before the token goes into `.env`. From now
  on every Codex review runs with `.env` locked (mode 000) and unlocked (600) right after; the rule is
  in CLAUDE.md.
- **Codex review** (`code-claude_telegram_integration-20260928-072222.md`), with `.env` locked (mode 0,
  a read attempt failed) and unlocked to 600 afterwards:
  - One finding (P2), confirmed with a test that failed and fixed. A session whose start folder was
    deleted kept its path as spelled, while the configured folders were resolved. On macOS
    (`/tmp` → `/private/tmp`) such a session got past the skip list and ping-only: `served: true`,
    content `full`.
  - Now a start folder that doesn't exist is not served and stays ping-only, and configured folders
    that don't exist match nothing. The recorded-session tests now expand `~` to a real temp folder.
  - Codex's own test run failed only because its read-only sandbox forbids temp folders (EPERM on
    `mkdtemp`); typecheck and lint passed there.
- **Learned:**
  - `env = false` in `bunfig.toml` turns off Bun's automatic `.env` loading for `bun <file>`,
    `bun run <script>` and `bun test`, and through `--config` from another folder (tested in a
    scratch folder, with a control). Neither the tests nor `ctl` put the real token into
    `process.env`, and the hooks get a second guard besides `--no-env-file`.
  - Codex reviews (`codex review --uncommitted`) run shell commands that can read any file in the
    repo, and what they read goes to OpenAI. Once `.env` holds the token, a review could leak it.

Committed as `345ddba` after the user's go (2026-09-28).

## 2.2 Telegram client

- **Date:** 2026-09-28
- **Result:** passed: the gate and the live check. Waiting for the user's confirmation, then a local
  commit.
- **Live check (the user, 2026-09-28):** `bun run ctl doctor` showed all eight lines ✓, the new one
  "✓ telegram the bot @… answers (getMe)" with the bot's name: the token in `.env` works against the
  real Bot API, and the output held no token.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 34 files … No fixes applied." ·
  `bun test` "191 pass, 0 fail" (after the Codex fix below), with no request URL anywhere in the test
  output.
  - Against a local fake Bot API (`tests/helpers/fake-telegram.ts`):
    - a 429 is retried after exactly its retry_after (2 → one wait of 2000 ms); one test really waits,
      and retry_after 1 took at least 990 ms;
    - after `maxRetries` 429 answers, or with a retry_after above 60 s, the call fails as "flood" and
      carries the wait;
    - 400, 401 and 409 are not retried. A non-JSON answer, a wrong shape, no connection, a timeout and
      a cancel each give a `TelegramError`;
    - no error (message, `String`, `Bun.inspect`, JSON) and no log line holds any 8-character piece of
      the token, even when an answer quotes the URL, and no log line holds message text.
  - Positive controls, each failing the tests: no wait before a retry (3 tests), the URL in a log line
    (1), Bun's own error kept as the `cause` (1).
- **Built:**
  - `src/shared/telegram/client.ts`: `getMe`, `getUpdates` (messages and button presses only, long
    polling), `sendMessage`, `editMessageText`, `answerCallbackQuery`, and `sendDocument`, which sends
    a text as a `.md` file.
  - `types.ts` checks the shape of every answer. A malformed update comes back as kind "other", so the
    offset still moves past it.
  - `errors.ts`: `TelegramError` (kind api, flood, network, timeout, cancelled or bad-answer), built
    from safe parts only.
  - `src/shared/log.ts`: log events take plain values only (ids, sizes, timings).
  - `ctl doctor` now asks Telegram who the bot is (`getMe`); on a 401 it says to check the token in
    BotFather.
- **Codex review** (`code-claude_telegram_integration-20260928-075817.md`), with `.env` locked (mode 0,
  a read attempt failed) and unlocked to 600 afterwards:
  - One finding (P2), confirmed with a test that failed and fixed. A cancel during a 429 wait was
    noticed only when the wait ended, up to 60 s later: with retry_after 1 and a cancel after 20 ms,
    the call took 1,003 ms. The wait now ends as soon as the client's signal aborts, and its timer is
    cleared; the same case takes under 500 ms.
  - Its test run failed only because its sandbox forbids temp folders and listening sockets.
- **Decisions (mine, open to change):**
  - Only a 429 is retried, because Telegram did not process it. A network error or a 5xx may come
    after the message arrived, and a retry could send it twice. The broker's poll loop retries
    `getUpdates` itself (2.3).
  - The client refuses to start while `BUN_CONFIG_VERBOSE_FETCH` is set (see Learned).
  - The Bot API address is fixed in the code; only tests pass another one. It is never read from the
    environment or `config.json`, where it could send the token elsewhere.
- **Learned:**
  - Bun's fetch errors keep the full URL, token included, in a `path` field. Their message is clean,
    but `console.log(error)` prints the token, so the client never lets Bun's error out: it builds its
    own.
  - `BUN_CONFIG_VERBOSE_FETCH` (`curl`, `1`) prints every request URL. Unsetting it after Bun has
    started does not turn it off, and setting it at runtime turns it on: a test that set it made the
    rest of the test run print URLs, with the fake token. The refusal test now runs in a process of
    its own.
  - Timeouts (`TimeoutError`) and aborts (`AbortError`) don't carry the URL. A `FormData` body can be
    sent again on a retry.

## Next

After the user confirms 2.2 and it is committed, and after the user's go: **2.3 Broker skeleton**.
`.env` holds the real token: scan only staged files, and lock `.env` during Codex reviews (CLAUDE.md).
