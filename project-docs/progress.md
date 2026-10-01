# Progress

The log of [implementation-plan.md](implementation-plan.md), newest step last. Each entry records the
date, the result, the evidence and what we learned. A new session reads this, then continues at **Next**.

## Phase 0: prerequisites (the user)

| Item | Status |
|---|---|
| 0.1 Bot created with BotFather | done (2026-09-28); the user keeps the token, it goes into `.env` at 2.1 |
| 0.2 Telegram two-step verification | on (2026-09-28) |
| 0.3 O3 git remote | local only (2026-09-27); GitHub from 2026-09-30 (D10) |
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

Committed as `8e554b1` after the user's go (2026-09-28).

## 2.3 Broker skeleton

- **Date:** 2026-09-28
- **Result:** passed: the gate and the live check, then the Codex review's two findings fixed and
  checked live again. Waiting for the user's confirmation, then a local commit.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 50 files … No fixes applied." ·
  `bun test` "218 pass, 0 fail" (after the Codex fixes below). No test broker was left running, and
  the tests never started this repo's broker.
  - The pass checks run as tests against a throwaway copy of the repo (`tests/helpers/repo-copy.ts`:
    `src/`, `bunfig.toml` and a `.env` with a fake token); its broker, hooks and ctl run as real
    processes:
    - `ctl start` twice leaves one broker, and `/health` answers. Of two brokers started at the same
      moment, one keeps running; the other logs "another broker holds the lock" and exits 0.
    - After kill -9, the next hook from a served session starts a new broker. With the disabled flag,
      `ctl disable` stops it, hooks don't start it and `ctl start` refuses; `ctl enable` undoes it.
    - Hooks from two unrelated repos reach the same broker. One repo has a `.env` with another token
      and a `bunfig.toml` whose preload writes a file; a control shows that both work when Bun runs
      there without our flags. With our flags, the broker reports this repo's bot id, its environment
      is exactly HOME, LOGNAME, PATH and USER, and the preload never ran (F13, F14).
    - A hook for an unserved session, with `BUN_CONFIG_VERBOSE_FETCH` set, or with input that isn't
      JSON exits 0 with no output; for bad input only its size is logged.
  - Positive controls, each failing the tests: the lock always granted (3 tests), the broker
    inheriting the session's environment (1), both disabled checks removed (1). Removing only the
    hook's check changed nothing, because `ensureBroker` checks the flag too.
  - Live check in this repo, 2026-09-28, with `bun run ctl` and hook calls made by hand:
    - status "not running"; `start` → "started (pid 64222)"; `start` → "already running (pid 64222)",
      one broker process; status "running … with this repo's token";
    - after kill -9, a hook from `sandbox/hostile-repo` (its own `.env` with a fake token, a
      `bunfig.toml` preload) started pid 64269, and a hook from `sandbox/plain-repo` reached the same
      pid. The broker log has both sessions under 64269, and the preload's file was never written;
    - `disable` → "stopped (pid 64269)"; a hook then started nothing; `start` refused; `enable`; the
      next hook started pid 64802; `stop` → "stopped (pid 64802)", socket removed;
    - `.state/` and `.state/logs/` are 0700; `broker.db`, `broker.lock` and `broker.log` are 0600.
      Afterwards the broker was left stopped and the two test folders were removed.
- **Built:**
  - `src/broker/`: `main.ts` (umask 077, the disabled flag, the lock, the token, the database, the
    server, a pid file, a clean stop on SIGTERM), `lock.ts`, `db.ts` (migrations by `user_version`;
    schema 1 is a `meta` table), and `server.ts` (`GET /health`, and `POST /hook/<event>`, which only
    logs for now).
  - `src/hooks/main.ts`: every hook event. It does nothing when disabled, for an unserved session or
    with bad input, and otherwise makes sure the broker runs and reports to it. It fails safe (D5).
  - `src/shared/broker-client.ts` (health, calls, start on demand, the broker's environment),
    `state.ts` (the `.state/` folder, the disabled flag), `file-log.ts` (JSON lines, 0600), `json.ts`.
  - `ctl start | stop | status | disable | enable` (`src/ctl/broker.ts`).
- **Codex review** (`code-claude_telegram_integration-20260928-084308.md`), with `.env` locked (mode 0,
  a read attempt failed) and unlocked to 600 afterwards. Two findings (P2), each confirmed by a test
  that failed on the old code (`tests/broker/disable-race.test.ts`), then fixed:
  1. `ctl disable` during a broker's startup: after the broker had looked at the flag but before it
     could be found, ctl found nothing and reported success, and the broker stayed up while disabled.
     The test holds `broker.db` to keep a starting broker in that window. Now the broker looks at the
     flag again once it can be found (socket and pid file), and then every second. ctl sets the flag
     before it looks, so either ctl finds the broker or the broker sees the flag. A flag set by hand
     now stops a running broker too.
  2. `ctl status` compared bot ids, which stay the same when a token is replaced in BotFather, so a
     broker still on the old token passed as "with this repo's token". `/health` now gives a
     fingerprint of the whole token (the first 16 hex digits of its SHA-256), and status compares
     that.
  - Found along the way: `BrokerDb.open` set `busy_timeout` after `journal_mode`, so a busy database
    failed the broker at once instead of making it wait; it is now set first.
  - Codex could not run the process tests: its sandbox forbids temp files.
  - Live again in this repo: `ctl status` says "with this repo's token" by fingerprint, with the real
    token. A flag set by hand (`touch .state/disabled`) stopped the running broker within 1.5 s
    ("broker.stopped", reason "disabled"). Then `ctl enable`; no broker running.
- **Decisions (mine, open to change):**
  - The single-instance lock is an exclusive SQLite lock on `.state/broker.lock`. The OS drops it
    when the process dies, even after kill -9, so there is never a stale lock (tested).
  - The broker runs detached in a session of its own (Bun's `detached`, which calls setsid), in the
    repo folder, with only PATH, HOME, USER and LOGNAME, taken from the user database. Its stderr goes
    to `.state/logs/broker.stderr.log`.
  - `ctl disable` sets the flag, then stops the broker; `ctl enable` only clears the flag.
  - `~/` in `config.json` means the home folder from the user database, not `$HOME`.
  - A hook refuses to run while `BUN_CONFIG_VERBOSE_FETCH` is set: Bun would print its requests on
    stdout, which Claude reads as the hook's output.
  - The broker doesn't call Telegram yet (the poller comes with pairing, 2.4). `/health` gives the
    bot id and a fingerprint of the token, so `ctl status` can say whether the broker uses the token
    now in `.env` without showing it.
- **Learned:**
  - Bun's `detached: true` calls setsid: the child outlives its parent, gets ppid 1 and a process
    group of its own, and receives only the environment passed to it.
  - An exclusive SQLite lock (`locking_mode = EXCLUSIVE` plus a write) refuses a second process at
    once with "database is locked", and a kill -9 of the holder frees it at once.
  - A bun:sqlite `Database` that is garbage-collected releases its connection, so the broker keeps
    the lock's connection in a module variable.
  - A bug of mine, caught by the tests: a log field named `event` overwrote the line's own event
    name. The log type now forbids the reserved names, and the file log writes them last.

Committed as `c6658db` after the user's go (2026-09-28).

## 2.4 Pairing

- **Date:** 2026-09-28
- **Result:** passed: the gate, the Codex finding fixed, and the live check. Waiting for the user's
  confirmation, then a local commit.
- **Live check (the user, 2026-09-28):**
  - The user ran `bun run ctl pair` and sent `/pair <code>` from their phone. The bot answered
    "Paired ✅ This chat now gets the bridge's messages from Claude Code on your Mac, and only you can
    answer them."
  - `ctl status`: "running … with this repo's token" and "paired with" the user's account.
  - The broker log shows the poller and the pairing starting together. A message sent before the
    `/pair` was dropped as "not paired yet", then the attempt had outcome "paired". The log held ids
    and outcomes only, no text and no code.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 61 files … No fixes applied." ·
  `bun test` "242 pass, 0 fail" (after the Codex fix below).
- **Codex review** (`code-claude_telegram_integration-20260928-174212.md`), with `.env` locked (mode 0,
  a read attempt failed) and unlocked to 600 afterwards. One finding (P2), confirmed by a test that
  failed and fixed:
  - The poller kept one offset whatever bot `.env` named. After a switch to another bot, the new bot
    would start from the old bot's offset, and Telegram would skip its messages, `/pair` included; the
    test showed another bot's first poll asking from offset 900.
  - Offsets are now kept per bot id (`telegram.offset.<bot id>`), so another bot starts afresh, and a
    token replaced for the same bot keeps its offset.
  - Codex could not run the new tests: its sandbox forbids temp files and listening sockets.
  - The pass check's tests (`tests/broker/gate.test.ts`, `pairing.test.ts`):
    - a wrong code is refused, with the tries left, and five wrong codes cancel the pairing;
    - an expired code, another user, and a group chat (even with the right code) are all refused;
    - the right code in a private chat pairs its sender, who gets "Paired ✅".

    After pairing, another user, a group, a bot and other kinds of update are dropped and logged
    with ids only; the log never holds message text.
  - `tests/broker/poller.test.ts`:
    - updates are handed over in order, and the offset is recorded after each and used after a
      restart;
    - a failing update is logged and passed;
    - a 409 waits 60 s and a 401 5 minutes;
    - an abort ends a long poll.
  - `tests/broker/app.test.ts` runs the broker's parts together against a fake Bot API:
    - no polling before pairing;
    - the `/pair` route starts polling, and the `/pair` message gets "Paired ✅", after which health
      says who is paired;
    - a paired broker polls at once after a restart.
  - Positive controls, each failing the tests: a group chat let through (2 tests), any user heard
    after pairing (2), codes that never expire (1), any code accepted (2).
- **Built:**
  - `src/broker/pairing.ts`:
    - codes are 8 characters from 30 that can't be confused (30⁸ ≈ 6.6 × 10¹¹), shown as
      XXXX-XXXX, valid 10 minutes, one use;
    - only their SHA-256 is stored, compared in constant time;
    - five wrong codes cancel the pairing;
    - a new pairing replaces the paired user once it succeeds.
  - `src/broker/gate.ts`: the decision for every update (design §5).
  - `src/broker/poller.ts`: the only poller (F8), with the offset recorded after each update, and
    backoff.
  - `src/broker/app.ts`: the parts wired together. `POST /pair` starts a pairing, and `/health` now
    says who is paired, whether a code is waiting and whether it polls.
  - `ctl pair`; `ctl status` shows the pairing.
- **Decisions (mine, open to change):**
  - The broker polls Telegram only once someone is paired or a pairing is pending. There is nothing to
    hear before that, and the process tests, which have a fake token and never pair, never reach the
    real Bot API.
  - A `/pair` gets an answer only while a pairing is pending (wrong code, tries left, cancelled);
    otherwise it is dropped in silence like any stranger's message. In a group it is dropped and not
    counted.
  - The paired user's other messages are accepted and logged, nothing more yet; replies to Claude come
    in phase 3.
  - Until plan 3.2's inbox, an update is handled and then its offset recorded: a crash in between
    would hand that one update over again. For pairing that is harmless, because the code is used up.
    3.2 stores each update first, for at-most-once delivery (D7).

## 7.8 `/new` opens a VS Code tab

- **Date:** 2026-10-01 (asked "Build it now (Recommended)" after the spike above; design rev. 28, D11,
  F30; plan rev. 19).
- **Built** (on `dev`):
  - The reply to `/new`'s question opens a new Claude Code tab in the window picked: `open -a` with the
    window's folder or workspace file brings it forward, then, a second later, the link of F23
    (`vscode-tab.ts`). Each window now keeps what it has open (`opened`).
  - The bridge's SessionStart hook sends its `source`. The broker hands the first VS Code tab to start
    (`startup`, `claude-vscode`) in that folder within 30 s the message, oldest first, and the hook prints
    it as `initialUserMessage`. Other sessions get nothing; one in another folder is logged
    (`new.tab-elsewhere`).
  - With no tab in 30 s, or when opening fails, the session runs in the background as in 7.7
    (`background-sessions.ts`, split out), and the chat hears "No Claude tab started in …". A window
    closed since the tap goes to the background at once.
  - `from_chat` now keeps where the session started: 1 in the background (as 7.7's rows), 2 in a tab.
    The entrypoint couldn't tell them apart, as every hook call rewrites it. Only background sessions
    count toward the limit of 3, and only they have no dialog at the Mac: a tab's questions go back to
    its dialog when you're back, like any session's.
  - The menu, `/new`'s texts, the README and CLAUDE.md say it opens a tab.
- **Tests:** 694 pass. New: the commands and their order, VS Code not running, a failing command, the
  messages waiting (oldest first, the timer, taken ones never late); the claim (resume, terminal, other
  folder, a second tab, two in order); the fallback after the wait and when the tab can't open; a closed
  window; tabs not counting toward the limit; the hook printing the message; the broker answering with
  it, asked with the source; a tab's question moving to its dialog; end to end, `/new`, a tap and a reply
  opening a stand-in tab whose SessionStart gets the message, once.
- **Positive controls**, 10, each caught: a resumed session or a terminal session taking the message,
  the hook dropping it, a tab with no dialog, a tab counted as background, no fallback after the wait or
  when the tab can't open, tabs counting toward the limit, the window not brought forward, the source
  not passed on. The tabs-and-limit one passed at first, so the limit test now opens 3 tabs first.
- **Live check, to come:** from the phone, `/new` in each of the two open windows: a tab opens in that
  window and works on the message, and its ✅ comes to the chat. Still unknown before it: whether the tab
  shows that first turn, and whether it opens in the window picked.

## Next

Committed as `98b9351` after the user's go (2026-09-28).

## 2.5 Formatter

- **Date:** 2026-09-28
- **Decision (the user, 2026-09-28), O1:** the full reply, capped. Claude's final message goes out
  redacted, up to about 3,500 characters in the chat; a longer one gets a button that sends the full
  text as a `.md` file, and folders listed in `config.json` get pings only. Recorded as D8 (design
  rev. 6, plan rev. 7). The config's content default is now `full`, with `content.maxChars` 3500.
- **Result:** code and tests done, gate green, the Codex findings fixed; the plan's pass check is the
  tests. Waiting for the user's confirmation, then a local commit.
- **Evidence:** `bun run typecheck` exit 0 · `bun run lint` "Checked 66 files … No fixes applied." ·
  `bun test` "264 pass, 0 fail" (after the Codex fixes below).
- **Codex review** (`code-claude_telegram_integration-20260928-180030.md`), with `.env` locked (mode 0,
  a read attempt failed) and unlocked to 600 afterwards. Two findings, both confirmed by tests that
  failed (9 of 11 in `tests/broker/redact.test.ts`), then fixed:
  1. (P1) A quoted setting value was masked only up to its first space or comma:
     `PASSWORD="correct horse battery staple"` kept "horse battery staple", and a short first word
     kept all of it. Now a quoted value is masked up to its closing quote, and an unquoted one up to
     the end of the line.
  2. (P2) Short credentials in an explicit header were missed: `Authorization: Basic dXNlcjpwYXNz`
     (user:pass) and `Authorization: Bearer abc123`. Now an `Authorization:` or
     `Proxy-Authorization:` header masks its credential, however short.
  - Found while fixing: backtracking let the end-of-line rule give back the space after the colon and
    mask an existing "[redacted …]" again, losing the kept name. A value now never starts with a
    space.
  - Positive controls, each failing the tests: no header rule (4 tests), quoted values cut at a space
    (4), values allowed to start with a space (10).
  - The pass check (`tests/broker/format.test.ts`; its fixture `tests/helpers/secret-samples.ts` is
    assembled at runtime):
    - one sample of each family: a private key, a JWT, a Telegram token inside a Bot API URL and
      ending in `-`, `sk-`, AWS, Google, GitLab, GitHub, Slack, Bearer and Basic credentials, and
      three `KEY=value` lines;
    - none survives, in the chat or in the full text, and each becomes "[redacted <family>]";
    - names and prefixes stay (`API_KEY=`, `Authorization: Bearer `, the Bot API URL), and so does
      `task-notification`, even in a longer word such as `task-notification-received-event`.
  - A long text full of `<`, `&` and emoji: no message exceeds 4096 characters, nothing is lost or
    doubled, and no message is cut inside an emoji or an escape.
  - Positive controls, each failing the tests: a `\b` before the token pattern (2 tests), no
    look-behind before `sk-` (1), a splitter that ignores escaping (1), no `KEY=value` family (2).
- **Built:** `src/broker/redact.ts`, and `src/broker/format.ts` (`formatReply`, `escapeHtml`,
  `split`); `content.maxChars` in `config.json`.
- **Decisions (mine, open to change):**
  - A mask names the family it hides, such as "[redacted GitHub token]".
  - Beyond the plan's list: `Basic` credentials (base64 of user:password), GitHub's other token kinds
    (`gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and AWS temporary keys (`ASIA`).
  - A `KEY=value` secret is a whole line that starts with the name (after `export` or a quote), so
    code such as `const TOKEN_KEY = "…"` is left alone.
  - Claude's Markdown goes out as escaped plain text, with only our header in bold; turning Markdown
    into Telegram formatting can come later.
  - A cut reply ends with a note of how much is shown; the button for the file comes with the
    notifications (2.7).
  - A message is at most 4096 characters even counting the HTML escapes. That is stricter than
    Telegram, which counts after parsing.
- **Learned:** my first `KEY=value` pattern took "Authorization" as a setting (it contains AUTH) and
  masked the word "Bearer" as its value; the tests caught it. A setting's value can no longer be
  `Bearer` or `Basic`.

## Next

Committed as `9793b5d` after the user's go (2026-09-28).

## 2.6 Presence

- **Date:** 2026-09-28
- **Decision (the user, 2026-09-28):** from now on the work goes on by itself. A step that passes is
  committed and the next one starts; the work stops only where the user has to act. Codex reviews are
  paused until the project is done. Recorded in CLAUDE.md and plan §1 (rev. 8).
- **Result:** passed, committed on its own under the new way of working. Live: the user locked the Mac
  by hand and the broker counted them away (locked) 4.7 s later; a `/status` from the phone was answered
  in 0.4 s. A `/status` sent while the Mac was locked was confirmed later, in 2.7's live check.
- **Evidence:**
  - `bun run typecheck` exit 0 · `bun run lint` "Checked 72 files … No fixes applied." · `bun test`
    "323 pass, 0 fail", four full runs in a row.
  - The recorder (`ioreg` once a second): `19:06:39 IOConsoleLocked=Yes sessionLocked=Yes
    keys=CGSSessionScreenIsLocked,CGSSessionScreenLockedTime idle=1801.4s`. The Mac locked itself
    after 30 minutes without input.
  - `ctl status` while it was locked: `presence: away (locked); idle 4426 s, screen locked; mode auto`,
    read by the live broker in its minimal environment.
  - The broker log follows the Mac on its own: active, in between after 30 s, away after 180 s, active
    again at the first input.
  - The manual lock: the recorder read `CGSSessionScreenLockedTime` 20:06:47, and the broker logged
    `presence.changed {state: away, because: locked}` at 20:06:51.741, 4.7 s later (plan: within 10 s).
  - A live `/status` at 20:04:23.656 (`getUpdates`, 354 bytes) → `command status` at .673 →
    `sendMessage` 200 at 20:04:24.082.
  - Positive controls, each caught by the tests: away at > 180 s instead of ≥ (1 test), active at
    ≤ 30 s (1), nanoseconds read as microseconds (8), an unknown idle time counted as away (4),
    `IOConsoleLocked` ignored (1), commands heard before the paired-user check (2), the mode not
    stored (2), only changes of state logged (1), the old lock (1).
- **Built:**
  - `src/broker/ioreg.ts`: `parseIdleSeconds` (`HIDIdleTime` in ns, F12), `parseScreenLocked` (F17), and
    `readPresence`, which runs `/usr/sbin/ioreg` twice at once with a 2 s limit and never throws.
  - `src/broker/presence.ts`: `stateOf` (flow 3: locked or ≥ 180 s away, < 30 s active, in between
    otherwise; an unknown idle time counts as active), and `Presence`, which looks every 5 s and keeps
    the mode in SQLite (`presence.mode`).
  - `src/broker/commands.ts`: `/status`, `/away`, `/auto`, `/off`; the gate answers them for the paired
    user only.
  - The broker loads `config.json` (the thresholds); `/health` and `ctl status` show presence.
  - Fixtures recorded on this Mac: `tests/fixtures/ioreg/IOHIDSystem.txt`, `Root-unlocked.txt` and
    `Root-locked.txt` (login and full name masked, the 93 KB `IOKitDiagnostics` shortened to `{}`).
- **Found along the way, a bug from 2.3:** two brokers started at the same moment could both give up
  the single-instance lock, leaving none. With `locking_mode = EXCLUSIVE` each kept the read lock it
  took first, so neither could write. The process test that starts two brokers at once failed about one
  run in three. A new test races 8 pairs of processes at the same instant; it failed in 2 of 3 runs. Now
  the lock is an open `BEGIN EXCLUSIVE` transaction with a 0.5 s busy timeout: SQLite fails the one that
  would deadlock, which lets go of its read lock, and the other gets the lock. Five runs since, all 40
  pairs had exactly one winner. A second broker now waits up to 0.5 s before it leaves, where 2.3's note
  says "at once".
- **Decisions (mine, open to change):**
  - Locked means `IOConsoleLocked = Yes`, or `CGSSessionScreenIsLocked`=Yes in the session on the
    console (F17). A lock that can't be read never makes you away.
  - `/away` lasts until `/auto`; it doesn't end by itself when you come back. `/status` says why you
    count as away, so a forgotten `/away` shows.
  - Presence looks at the Mac from the broker's start, paired or not.
  - Another command, such as `/start`, is a plain message for now. Phase 3 must not hand it to Claude.
  - Logs: `presence.changed` on a change of state or of its reason; `presence.unreadable` and
    `presence.readable` when what can't be read changes; `presence.mode`; `command`. No message text.
- **Learned:**
  - macOS checks a newly written executable the first time it runs: 0.3 to 0.7 s here, and over 2 s
    under test load, which timed out a stand-in `ioreg`. The real `/usr/sbin/ioreg` never pays it, and
    the stand-ins now get 10 s.
  - `ioreg -n Root -d 1` prints 94 KB, 93 KB of it `IOKitDiagnostics`; both reads take about 20 ms.
  - This Mac locks itself after 30 minutes without input, so an unattended Mac becomes "away (locked)"
    at 30 minutes; "away (idle)" comes first, at 3 minutes.

## Next

Committed as `edf80ed` (2026-09-28).

## 2.7 Notify hooks + install

- **Date:** 2026-09-28 to 2026-09-29
- **Result:** passed. Live, with our hooks in `~/.claude/settings.json`:
  - A new sandbox session with `/away` got its ✅ 1.7 s after the stop, and it listed a dev server left
    running in the background.
  - At the keyboard with `/auto`, nothing was sent.
  - The build session sent nothing, also after it `cd`'d into `sandbox/`.

  2.6's leftover is confirmed too: a `/status` sent while the Mac was locked was answered.
- **Evidence:**
  - `bun run typecheck` exit 0 · `bun run lint` "Checked 86 files … No fixes applied." · `bun test`
    "370 pass, 0 fail", twice.
  - **Install.** The user ran `bun run ctl install` after their OK (see Learned).
    - `ctl.log`: `hooks.installed {hooks: 8, replaced: 0}`.
    - Backup: `.state/backups/settings.2026-09-28T20-41-22-093Z.json` (0600).
    - Compared with the backup (key names and counts only): nothing outside `hooks` changed, and each of
      the 8 events holds exactly its old groups plus ours at the end (`StopFailure` is new).
    - The file already round-tripped byte for byte, so no other line changed. Its mode stayed 644.
  - **A new sandbox session** (VS Code, Claude Code: Open in New Tab): `hook.event SessionStart` came 2 s
    after the tab opened. The broker registered `7af8…` as `sandbox`, `claude-vscode`, branch `main`.
  - **"say hi" with `/away`** (`presence.mode away`):
    - UserPromptSubmit at 20:51:00.442 and Stop at 20:51:04.413.
    - `hook.stop finish, no continuation entry` 0.2 s later.
    - `notice.sent finish` at 20:51:06.105 (`sendMessage` 200 in 1.5 s).
  - **A background dev server** (`python3 -m http.server 8765`):
    - Two 🔐 pings for its permission dialogs (`notice.sent permission`).
    - Then `hook.stop … tasks: 1`, and the ✅, which listed the server.
    - When I stopped the server, the task's exit woke the session by itself: UserPromptSubmit, a 🔐 ping,
      a Stop and a ✅ (still `/away`).
  - **"say hi" with `/auto` at the keyboard:** `stop.result finish, current`, then `notice.skipped … at
    the Mac` at 22:57:23.454. Nothing reached the phone.
  - **The build session.** It ran our Stop hook from then on: its `stop_hook_summary` lists our command,
    with no hook errors. That held after a `cd` into `sandbox/` too (the summary's `cwd` was
    `…/sandbox`). The broker never heard from it: since the install, every `hook.event` came from the
    sandbox session.
  - **2.6's leftover:** the broker counted the Mac away (locked) at 23:02:52.971. `command status` at
    23:02:58.983 was answered (`sendMessage` 200) at 23:02:59.329, with the Mac still locked. The user saw
    the expected "🔴 Away: the screen is locked".
  - **Before the install:** real sessions that didn't touch `~/.claude/settings.json`.
    - The setup: `claude -p` (2.1.274) in a throwaway repo copy, with our hooks loaded through
      `--settings` and `--setting-sources project`, a fake token and an unpaired broker.
    - SessionStart started the broker (schema 2). UserPromptSubmit and Stop each began a generation.
    - The Stop hook classified the real transcript as `finish` ("no continuation entry") within 2 ms.
    - The broker logged `stop.result … current: true` and `notice.skipped … not paired`. SessionEnd
      arrived last.
    - A second run left `sleep 45` running in the background. The Stop input carried it (`tasks: 1`),
      and the stop still counted as a finish, 0.2 s after the Stop.
  - The classifier replayed on real transcripts, each stop seen only up to its own summary: all 129
    stops of this build session (41 continuing, blocked by the Codex hook; 88 finishes), and 11 in the
    sandbox transcripts from the panel and the terminal.
  - Positive controls, each caught: install without removing ours first (1 test), uninstall taking
    every hook as ours (3), subagents not skipped (2), no cancel barrier (1), continuation entries
    ignored (5), notices while at the Mac (2), ping-only text sent (1), a ping for AskUserQuestion's
    permission dialog (1), a second ✅ after idle_prompt (1), the prompt check dropped (1, after adding
    the test it showed was missing).
- **Built:**
  - Hooks: `src/hooks/main.ts` runs each event's handler (`events.ts`) for served sessions only, never in
    a subagent (`agent_id`). SessionStart registers the session and adds the note; UserPromptSubmit is
    the cancel barrier; Stop registers, classifies (`finish.ts`, F16) and reports; Notification
    (`idle_prompt`), PermissionRequest (not for AskUserQuestion), PreToolUse (AskUserQuestion),
    StopFailure and SessionEnd report to the broker. `branch.ts` reads the branch from `.git/HEAD`,
    without running git in the session's repo.
  - Broker: `sessions.ts` (schema 2: sessions and their generations), `hook-events.ts` (a stop's result
    counts only in its generation; idle_prompt sends a ✅ an unknown or held-back stop didn't),
    `notifier.ts` (only while away and not muted; D8 formatting; the 📄 button), `notices.ts` (✅ 🔐 ❓
    ⚠️), `full-texts.ts` (the 📄 texts, in memory only, a day at most).
  - `ctl install [--dry-run]` and `ctl uninstall [--dry-run]` (`src/ctl/install.ts`, `setup.ts`): a
    backup first, our hooks recognised by their command path, one rename to write, refused for a
    symlink or a file changed meanwhile.
  - The spike code is deleted with its tests (`scripts/spikes/`, `tests/spikes/`); the fixtures stay.
- **Decisions (mine, open to change):**
  - Phase 2's entries wait for nothing, so their limits are short: Stop is `async` with 60 s (design §3
    has `asyncRewake`, 12 h, for phase 3) and the AskUserQuestion hook has 10 s (12 h in phase 4). Both
    go up with `ctl install` when those phases need them.
  - Notices go out only while you are away (not in between); `/off` mutes them. A ✅ held back because
    you were at the Mac can still go out at `idle_prompt` (terminal only) if you have left by then.
  - Labels: folder, branch and the first 4 characters of the session id, e.g. "sandbox (main) · b1e8".
  - Running background tasks are listed first in the ✅, at most five by name; ping-only folders get a
    count only. A permission ping shows the command, file or URL; a question ping its options.
  - The note names the paired user's first name from Telegram, or "the user" when none is paired.
  - The 📄 texts stay in memory only, so none of Claude's text is written to disk.
- **Found along the way:**
  - A resumed or compacted session's transcript holds earlier entries a second time, with the same
    uuids. The classifier only looks at the entries up to the current stop, so they do no harm; the
    replay above includes such stops.
  - Two backups in the same millisecond had the same name, and the second write was refused; backups
    now get a number.
  - A formatting error in the last test added (the prompt check) had slipped past; the final gate caught
    it.
- **Learned:**
  - Claude Code's auto mode refused to let me run `ctl install`, even after the user's OK: writing
    `~/.claude/settings.json` counts as Claude changing its own settings. The user runs `ctl install` and
    `ctl uninstall` themselves (CLAUDE.md now says so). Later installs will go the same way, such as
    phases 3 and 4 raising the limits.
  - A session that is already running takes up hooks added to `~/.claude/settings.json` without a
    restart (2.1.283): this build session ran our Stop hook 8 minutes after the install. An uninstall
    should act the same way, but that hasn't been seen yet.
  - `code -n <folder>` brings forward a window already open on that folder rather than opening a second
    one, and its Claude panel may show an older conversation. Claude Code: Open in New Tab (Cmd+Shift+Esc)
    starts a new session, whose SessionStart runs as soon as the tab opens, before any prompt.
  - A background task that exits wakes its session as if prompted: UserPromptSubmit runs, so the
    generation moves on, and then a Stop. While you are away, that turn's ✅ goes out like any other.
  - The live check was done one small step at a time, each waiting for the user (their wish, 2026-09-29).

## Next

Committed as `2abcdaa` (2026-09-29).

## 2.8 Finish detection and the Codex hook

- **Date:** 2026-09-29
- **Result:** passed. No change to `src/` was needed: the 2.7 classifier gave the right outcome on every
  recorded stop and in every live check.
  - With throwaway Stop hooks (a block, `additionalContext`, a crash), each prompt got exactly one ✅,
    only after the real finish.
  - With the Codex hook, the ❓ came first and exactly one ✅ followed the real finish. That held with a
    31 s continuation too.
- **Evidence:**
  - `bun run typecheck` exit 0 · `bun run lint` "Checked 91 files … No fixes applied." · `bun test`
    "419 pass, 0 fail", twice.
  - **Recorded:** 7 scenarios × 2 versions, 30 stops in all. The versions are 2.1.283 (the VS Code
    extension's) and 2.1.274 (the terminal's).
    - `scripts/record-stops.ts` runs `claude -p` in scratch folders, with throwaway hooks loaded through
      `--settings` and `--setting-sources project`. It deletes those sessions' transcripts afterwards.
    - The scenarios: a block, a block twice, `additionalContext`, a crash, a block with
      `continue: false`, the same text in two turns, and the same text with a block.
    - Claude Code did what each scenario set up: the truths match `EXPECTED` for both versions.
  - **Tests on them** (49):
    - Each stop is still undefined when its hook starts, and has its true outcome once its summary is
      written (30 stops).
    - Through the broker, exactly one ✅ per prompt, with the real finish's text (14 recordings).
    - A prompt typed before a ✅ went out cancels that ✅ and not the next one.
    - The summary's line half written; the summary written before the waiter started; and written while
      it waits.
  - **Positive controls**, each caught (failing tests):
    - the prompt check dropped (4);
    - `additionalContext` not a continuation (4);
    - a blocking error not a continuation (20);
    - `preventedContinuation` ignored (4);
    - `hookErrors` taken as the signal (8);
    - a partial line not skipped (1);
    - no cancel barrier (1);
    - a ✅ for a continuing stop (9).

    The last two first missed, because they broke only one of two guards (the generation is checked in
    two places, and a continuing stop never reaches the ✅ code). They were rewritten to break the path
    that runs.
  - **Live, throwaway hooks.** Session `b057`, `/away`, the hooks in `sandbox/.claude/settings.local.json`;
    a file I wrote between prompts chose which one acted.
    - Block: Stop at 05:48:44.788 → `continuing` 0.2 s later. Stop at 05:48:46.624 → `finish` → one ✅,
      and the user got it.
    - `additionalContext`: 06:01:18.937 `continuing`, then 06:01:21.351 `finish` → one ✅.
    - Crash: 06:02:03.706 `finish` despite the hook's error → one ✅, 0.6 s later.
  - **Live, the Codex hook.** `sandbox/` is now its own git repo, so the hook sees changes made there.
    - `hello.py` (`b057`): 🔐 Write and 🔐 Bash. The stop at 06:15:38.806 was blocked by the Codex hook
      → `continuing` 0.4 s later. The ❓ went out at 06:15:42.801. The real finish at 06:15:53.846 sent
      the one ✅. The continuation took 15 s.
    - `bye.py` (`b057`) and `hi.py` (`e28b`, a fresh tab): Claude asked about Codex by itself before
      stopping. The Codex hook still blocked the stop (`continuing`); Claude said it had already asked.
      One ✅ each, but the continuations took under 3 s.
    - `yo.py` (`c907`): a "slow" throwaway hook asked for `sleep 25`. Claude Code refused a foreground
      `sleep`, so Claude ran it in the background. That turn finished with the task listed in its ✅.
      The task's end woke the session: a second turn, with its own ✅.
    - `ok.py` (`80a0`): the slow hook asked for a foreground Python wait instead.
      - The ❓ went out at 10:25:05.416.
      - The stop at 10:25:12.393 was blocked by the Codex hook and the slow hook → `continuing` 0.4 s
        later.
      - The wait ran from 10:25:15, and the real finish came at 10:25:43.683.
      - One ✅ at 10:25:44.260: a 31 s continuation.
  - A tool declined at the Mac (06:30:34) ended the turn as interrupted. No Stop hook ran and nothing was
    sent.
- **Built:**
  - `scripts/record-stops.ts` and `scripts/throwaway-stop-hook.ts`. The hook's behaviors: record, block,
    block2, slow, context, crash, prevent. An `only` file lets a live check switch between them.
  - `tests/fixtures/transcripts/<version>/`: each scenario's cut-down transcript (`.jsonl`) and its stops
    (`.json`).
  - `tests/helpers/recordings.ts`, `tests/hooks/finish-recorded.test.ts` and
    `tests/broker/stops-recorded.test.ts`.
  - Design rev. 8: F16 adds what the recordings showed, and flow 1 names the prompt check. CLAUDE.md
    names the recorder and the sandbox's git repo.
  - `sandbox/` is a git repo of its own: a baseline commit, plus the live check's files. The throwaway
    settings were removed after the check.
- **Decisions (mine, open to change):**
  - Fixtures keep only what the classifier reads and what shows the chain, with home paths masked:
    - `type`, `subtype`, `uuid`, `parentUuid`, `promptId`, `isMeta`, `timestamp`,
      `preventedContinuation`, `hookCount`, `hookErrors`, `level`;
    - the message's id, role and text;
    - the attachment's type.

    Thinking, tool inputs and other attachments' contents are left out.
  - A recorded stop's truth comes from what Claude Code did (whether another stop of its prompt
    followed), never from our classifier.
- **Learned:**
  - A stop's own assistant entry reached the transcript after its Stop hooks had started in 28 of 30
    recorded stops: all 15 on 2.1.283 and 13 of 15 on 2.1.274. So the waiter's first read rarely finds
    it, and the prompt check is what keeps an earlier turn's identical stop from being taken (F16).
  - `hookErrors` carried the blocking reason in 12 of 16 blocked stops.
  - Attachment types seen besides F16's: `hook_stopped_continuation` (with `continue: false`),
    `hook_success`, `hook_non_blocking_error` (a crash) and `prompt_snapshot`. With a block and
    `continue: false` together, Claude Code writes `hook_blocking_error` and still ends the turn
    (`preventedContinuation: true`).
  - The user's global CLAUDE.md makes Claude offer a Codex review by itself before stopping. The Codex
    hook then blocks once more for the same change, and Claude answers that it already asked. Still
    exactly one ✅.
  - Claude Code refuses a foreground `sleep`. A background task's end starts a new turn, with its own ✅
    while you are away.
  - `claude -p --resume <id>` adds to the same session and transcript.
  - Telegram shows Claude's Markdown as typed (`[hello.py](hello.py)`, backticks). It also turns file names
    such as `hello.py` into links, because `.py` is a country's domain. D8 sends the text as plain text.
    Rendering Markdown as Telegram formatting, with file names as code, would change D8: a question for
    the checkpoint.

## Next

Committed as `426a330` (2026-09-29).

## Phase 2 checkpoint

- **Date:** 2026-09-29
- **Decisions (the user's):**
  - **Served folders:** all of `~`, this build session included. `config.json` is now the template
    with `"serve": ["~"]`. `ctl doctor` passes (`serve ~`, entrypoints `claude-vscode, cli`).
  - **How phase 3 is built:** in a git worktree, `../claude_telegram_integration-dev` on branch `dev`.
    The installed hooks run this working copy's code for every session under `~`, so `main` here only
    moves, by fast-forward, to a step whose gate passed; then the broker restarts and the live check
    runs. Recorded in CLAUDE.md.
- **Before that:** the user went back to `/auto` after the live checks. The broker keeps running the 2.7
  code; `serve` is read by the hooks on each run, so no restart was needed.
- **Now running:** a day of notify-only use. The user tells me what is noisy. Also for them: the Markdown
  question from 2.8 (render it, and file names as code?).

## Next

Committed as `1342b1b` (2026-09-29). Phase 3, step 3.1 (waiter protocol), built in the worktree. The day
of use goes on meanwhile; its feedback may change phase 2's notices first.

## 3.1 Waiter protocol

- **Date:** 2026-09-29
- **Result:** passed (automated; plan 3.1 has no live check). Built on branch `dev` in the worktree.
  `main` stays on phase 2 until 3.3 (see Decisions).
- **Evidence:**
  - `bun run typecheck` exit 0 · `bun run lint` "Checked 104 files … No fixes applied." · `bun test`
    "456 pass, 0 fail", twice.
  - The plan's cases, each a test:
    - Both race orders (`relay.test.ts`): a reply first is handed over, and your typing then only says it
      crossed; typing first cancels the waiter, and the reply finds nobody waiting.
    - A late cancel, typed before a newer stop, leaves that stop's generation and waiter alone.
    - An old waiter that ends after its replacement registered leaves the session listening.
    - A waiter that ends while the broker is down: its end waits on disk, and the next broker applies it.
    - A broker crash after fetching an update (`poller.test.ts`: storing fails, the offset stays, the
      update comes again), after storing it (the next broker routes it), and after handing it over (the
      waiter confirms to the next broker; or, its hook gone too, you're told and it isn't resent).
  - Real processes (`wait-process.test.ts`, a throwaway repo copy):
    - A Stop hook with `--wait` waits; SIGTERM ends it with exit 0 in under 2 s, and its waiter is ended.
    - A reply stored before the broker was killed with SIGKILL: the hook started a second broker, got
      the reply, confirmed it, and exited 2 with "📨 Telegram reply from the user: now say bye".
  - Positive controls, each caught (failing tests):
    - a reply handed to a waiter that isn't waiting (1);
    - a cancel that reaches waiters registered after it (2);
    - a late cancel that moves the generation on (1);
    - a newer stop that leaves the older waiter waiting (1);
    - cancels and ends on disk never applied (2);
    - dead waiters never swept (1);
    - stored replies never routed after a crash (3);
    - the offset moved before the reply is stored (2);
    - an unknown command taken as a reply (1);
    - a reply injected without confirming (6);
    - a SIGTERM'd waiter that never reports its end (2);
    - typing with no broker leaves no cancel (1);
    - every Stop waits, `--wait` or not (2).
- **Built:**
  - Schema 3: `waiters` (one per session and generation: waiting → handed → delivered, or cancelled or
    ended), `inbox` (replies by `update_id`), and `sessions.stopped_at`.
  - `src/broker/waiters.ts`, `inbox.ts`, `relay.ts`: every race is one SQL update on a waiting row. The
    relay holds each waiter's Wait up to 25 s and answers it when there is news. At start, before the
    poller, it applies what hooks left on disk, ends waiters whose hook or Claude is gone (reporting a
    reply handed to one), and routes replies a crash left unrouted.
  - The poller stores a reply before it moves the offset, then handles the update. The gate takes the
    paired user's text as a reply, never a command (not even an unknown one such as `/start`).
  - Hooks: `src/hooks/waiter.ts` long-polls Wait, confirms a reply before returning it, and stops on
    SIGTERM, the disabled flag or Claude gone. The Stop hook waits only when installed with `--wait`,
    and wakes Claude by exiting 2 with "📨 Telegram reply from <name>: …". UserPromptSubmit sends when
    you typed. With no broker, a cancel or a waiter's end is written to `.state/pending/`.
  - `ctl install`: the Stop entry becomes `asyncRewake`, 12 h, with `--wait` (installed at 3.3).
  - Design rev. 9: F18.
- **Decisions (mine, open to change):**
  - Waiting is tied to the install: only a Stop hook installed with `--wait` (and `asyncRewake`) waits.
    Code that reaches `main` before its install never swallows a reply Claude couldn't be woken for.
  - A reply that can't be confirmed is never injected: the broker reports it, and doesn't resend it
    (plan 3.1). "Unknown" stops wait too: a reply to them is still useful, and the next stop ends them.
  - For now a reply goes to the one session listening; with none or several, you're told it wasn't
    delivered. Plan 3.2 adds reply-to, the picker and the queue.
  - Messages about your replies (crossed, unconfirmed, nobody listening) are sent whatever the presence
    or `/off`: they answer something you just did.
  - A reply's text is on disk (the inbox) only until it is delivered or given up; then it is erased.
  - `main` moves to phase 3 only at 3.3: schema 3 would stop phase 2's code from opening the broker's
    database, so a half-built phase 3 must not reach the live broker. CLAUDE.md says so.
- **Learned:**
  - Hooks run as direct children of the Claude Code process, for sync and `asyncRewake` hooks alike
    (F18, probed with a real `claude -p`). So a waiter watches its parent pid.
  - Bun 1.4.1 cuts a request on a Unix-socket server after 10 s unless `idleTimeout` is set (seen: the
    14 s request failed at 12 s). Its types allow `idleTimeout` only for TCP, but it works on a Unix
    socket (the 14 s request was answered); `server.timeout(request, …)` did not help. The server
    passes it through a typed cast, with a comment.

## Next

Committed on `dev` as `925a6f9` (2026-09-29).

## 3.2 Routing and queue

- **Date:** 2026-09-29
- **Result:** passed (automated; the live check is 3.3). On `dev`, like 3.1.
- **Evidence:**
  - `bun run typecheck` exit 0 · `bun run lint` "Checked 107 files … No fixes applied." · `bun test`
    "468 pass, 0 fail", twice.
  - The plan's cases, each a test (`router.test.ts`):
    - A reply-to goes to its notice's session, even with another session waiting.
    - The single waiting session gets a plain message.
    - With several waiting, the picker asks "Which one", with a button per session and "Don't send it";
      the chosen session gets the reply.
    - Nobody listening: you're told, in the thread of your message, and nothing is kept.
    - Queued while busy: two replies-to a busy session are queued ("is busy"), and its next stop's Wait
      gets both, as "first", a blank line, "second".
    - A repeated `update_id` is stored once and routed once.
    - An answer for an expired request: a second press, or one 10 minutes on, sends nothing ("That choice
      has expired").
    - Also: a session that ends with a queue loses it, and you're told; a reply-to an ended session too.
  - End to end in the broker, against the stand-in Bot API (`app.test.ts`): a ✅ goes out and is linked;
    your reply-to it comes in through `getUpdates`, is stored, routed and queued (the session had no
    waiter yet); its Wait then gets it, "from Hamed".
  - Positive controls, each caught (failing tests):
    - a reply-to ignored (4);
    - no picker, the first of several sessions taking it (3);
    - a picker answer after 10 minutes accepted (1);
    - a second picker answer accepted (1);
    - a repeated update routed again (1);
    - the queue not handed over at the next stop (2);
    - only the newest reply handed over, not the queue (1);
    - a lost queue not reported (1);
    - notices not linked (2).
- **Built:**
  - Schema 3, amended before it went anywhere: the inbox's states `choosing` and `queued`, and `outbox`,
    which links each notice's message id to its session and generation (kept a week).
  - `src/broker/router.ts`: where a reply goes. Every decision is made in the database at once; only the
    messages about it are sent afterwards, so at start all stored replies are placed before the poller
    runs.
  - `relay.ts`: `deliver()` hands a session's queued replies and the new one to its waiter together, or
    queues them. A session's next waiter gets its queue the moment it registers. Confirming or ending
    settles the whole group.
  - The notifier links every message it sends; the gate routes replies through the router; a press of a
    picker button goes to the router, a 📄 press to the notifier.
- **Decisions (mine, open to change):**
  - A reply-to any notice of a session (✅, 🔐, ❓, ⚠️) goes to that session, whatever its generation:
    the session is the conversation. A reply-to an unknown or week-old message counts as a plain one.
  - "Busy" means the session exists, hasn't ended, and has no waiting hook: Claude is working, or its
    last stop continued, or the hook isn't waiting yet. Queued replies go in at its next real finish,
    joined by a blank line, as one "📨 Telegram reply".
  - A plain message with nobody waiting isn't queued anywhere: the bot says so and suggests a reply-to.
  - The picker's buttons work 10 minutes, once. They name the sessions by label.

## Next

Committed on `dev` as `c917760` (2026-09-29).

## 3.3 Live

- **Date:** 2026-09-29
- **Result:** passed, with the user one small step at a time. Phase 3 is live for every session under `~`.
  - A reply from Telegram continued a VS Code session, which answered.
  - Ten round trips in a row worked.
  - Typing at the Mac while a hook waited edited that stop's ✅ to "↩️ continued at the computer" and
    injected nothing.
- **Built first** (on `dev`, `b3d5b26`): the ✅ edit.
  - The notifier keeps each ✅'s last message in memory only (D8), for a day.
  - A cancel of a waiting hook edits that ✅ (an edit, so the phone stays quiet).
  - A reply that crossed the typing keeps its own message.
  - Gate: typecheck exit 0, "Checked 107 files … No fixes applied", "470 pass, 0 fail", twice.
  - Positive controls, each caught: the ✅ never edited (1 failing test), a cancelled waiter not
    reported (1), a crossed one reported as cancelled (2).
- **Going live:**
  - The live database was backed up at schema 2 (`VACUUM INTO`, 11 sessions):
    `.state/backups/broker.pre-schema3.2026-09-29T11-19-27Z.db` (0600).
  - `main` was fast-forwarded to `b3d5b26`, and the broker restarted on it: pid 9778, schema 3, polling.
  - After the user's OK, they ran `bun run ctl install`: `hooks.installed {hooks: 8, replaced: 8}`.
  - Compared with the backup `settings.2026-09-29T11-25-04-494Z.json`: nothing outside `hooks` changed,
    the other hooks are the same, and ours are exactly the phase 3 entries. Only the Stop entry changed:
    `Stop` → `Stop --wait`, and `timeout 60, async` → `timeout 43200, asyncRewake`.
- **Evidence** (broker log; `/away` on):
  - **A reply that continues a session:** "now say bye", sent as a plain message.
    - Stored at 13:58:40.315.
    - Two sessions were waiting (the sandbox's and this build session's), so the picker asked.
    - The sandbox's button at 13:58:47.148 → handed over, and confirmed 11 ms later.
    - The sandbox woke at 13:58:47.284 and answered; its ✅ went out at 13:58:52.235.
  - **Just before that**, the user replied to this build session's ✅ by mistake (it was the newest
    message). The reply-to took "say bye" to this session, which woke with "📨 Telegram reply from Hamed:
    say bye": routing as designed.
  - **Ten round trips**, "say 1" to "say 10", 14:11:40 to 14:15:23:
    - each reply was a reply-to the sandbox's newest ✅;
    - each was routed to `0253`, handed over and confirmed within 16 ms;
    - each answer's ✅ came 2.4 to 7.9 s later. No failures.
  - **Typing at the Mac mid-wait:** the prompt at 14:17:19.489 cancelled the waiter (generation 24).
    `editMessageText` 200 at 14:17:19.863, `notice.continued`. Nothing was injected.
  - **Meanwhile, in the user's other work:** a session in `agent-panel-frontend` had waits registered after
    its finishes, each cancelled when they typed there. This build session's ✅s were edited each time
    the user answered here.
- **Learned:**
  - A wake fires `UserPromptSubmit`, about 0.1 s after the hook exits (13:57:31.294, 13:58:47.284). The
    cancel it causes finds nothing, since the woken waiter has just delivered. Now in F2 (design rev. 10).
  - With `/away` on, this build session's ✅s interleave with the sandbox's on the phone, so "the newest
    message" can belong to another session. A reply-to goes where its message came from; the labels tell
    them apart.
  - This build session started before 2.7, so it has no SessionStart note. Its harness showed the wake as
    a hook message, not your words, and it didn't act on it: the note matters.
  - A 12-step live check went through one small step at a time. Ten round trips as one step didn't
    happen; one round trip, then "carry on up to 10", did.

## Next

Committed as `279a93f` (2026-09-29). Then the user settled the two open questions: Claude's Markdown is
rendered (D8, design rev. 11), which became step 3.4 (plan rev. 9), and nothing in the day of use was
noisy ("Nothing so far").

## 3.4 Claude's Markdown in Telegram

- **Date:** 2026-09-29
- **Result:** passed, with the user one small step at a time. Every ✅ shows Claude's Markdown as
  Telegram formatting.
- **Built** (on `dev`, `7eeeffc`):
  - `src/broker/markdown.ts`: Claude's Markdown as Telegram HTML, in whole units (a line of text, a code
    block, a table), each one closing its tags and short enough for a message.
    - Headings go bold, list items get bullets.
    - Bold, italics, strikethrough and inline code; code blocks in their language.
    - A web link stays a link; a link to anything else shows its label as code.
    - File names and paths are code, so Telegram doesn't make links of them (`hello.py` is a domain).
  - `format.ts` packs the units into messages. The notifier sends a message Telegram refuses ("can't
    parse entities") again as plain text, and logs `notice.plain`.
  - Gate: typecheck exit 0, "Checked 109 files", "481 pass, 0 fail", twice.
  - Positive controls, each caught: file names left as text (1 failing test), no plain resend (1),
    messages packed past the limit (2), italics, strikethrough or underscores wrapping tags (2 each). The
    italics control missed at first; the tests now include marks that cross (`~~a **b~~ c**`).
- **Going live:** `main` was fast-forwarded to `7eeeffc` and the broker stopped (pid 9778). A waiting hook
  started it again within a second: pid 18156 at 18:41:07, a second after the commit, schema 3. The two
  waiting hooks (`219e`, `0253`) stayed connected.
- **Evidence** (`/away` on at 15:14:14; broker log):
  - **A Markdown-rich ✅:** the sandbox was asked for a heading, bold, `hello.py`, a table and a python
    block. Its ✅ went out with `sendMessage` 200 at 15:16:41.362 (`notice.sent`, 1 message). On the
    phone (screenshot): heading and phrase bold, `hello.py` as code (from a `[hello.py](hello.py)` link
    too), the table in a monospace block, the python block highlighted.
  - **The table's columns didn't line up:** Claude doesn't pad its cells. Fixed on `dev` (`811e1e0`,
    `src/broker/table.ts`): each cell padded to its column, emoji and East Asian wide characters counted
    as two columns, code and bold marks dropped in cells.
    - Gate: "Checked 111 files", "485 pass, 0 fail", twice.
    - Controls, each caught (1 failing test each): emoji as one column, widths of the escaped text,
      alignment colons ignored, marks kept, no delimiter row needed.
  - **Live again**, in this build session's own ✅ (away mode relays it too): the text lined up, but each
    emoji pushed its row's closing pipe out. Telegram draws an emoji about 2.4 columns wide.
    - Fixed (`5aca60a`): tables drawn as psql draws them, without pipes at either end.
    - One more control: trailing spaces kept (2).
  - **Live a third time**, the same table: every pipe straight but one, half a character right in the
    row with an emoji before it, as predicted.
  - 7 ✅s went out from 3.4's start to the end of the check; no `notice.plain`. Then the user went back to
    `/auto` (15:35:12).
- **Learned:**
  - Telegram draws an emoji in a code block about 2.4 columns wide (in the user's app), not 2, and the
    width differs between apps and text sizes: no padding lines an emoji up exactly. Without pipes at the
    ends, an emoji in the last column doesn't matter, and that's where Claude puts most of them.
  - Telegram shows a code block with no language under a "copy" header; one with a language is
    highlighted under its name.
  - `ctl stop` is no pause: a waiting hook starts the broker again within a second, on the code in the
    working copy at that moment. So `main` is fast-forwarded first, then the broker stopped.
  - With `/away` on, this build session's own ✅ can carry a live check's sample, so the user only looks.

## Next

Committed as `756758f` (2026-09-29).

## 4.1 Answer Claude's questions from Telegram

- **Date:** 2026-09-29
- **Result:** passed, with the user one small step at a time. Every session under `~` now relays Claude's
  questions while the user is away or in between.
- **Built** (on `dev`, `7fb7d4a`; design rev. 12):
  - **The question hook** (`PreToolUse` on `AskUserQuestion`, installed with `--wait`; `src/hooks/
    question.ts`, `asker.ts`) asks the broker where a call goes.
    - It goes to the dialog at the Mac while the user is active, muted, unpaired, or in a ping-only
      folder. Otherwise it goes to the chat, and the hook holds its Ask as a Stop hook holds its Wait.
    - It confirms the answers, then prints them for Claude as `allow` plus `updatedInput.answers` (F4).
      Without `--wait` it only sends phase 2's ping.
  - **The broker** (`asks.ts`, `ask-relay.ts`, `ask-messages.ts`, `ask-chat.ts`, `questions.ts`; schema
    4 adds `asks` and `ask_questions`):
    - One message per question, with a button per option; a multi-select gets toggles and Done, and
      its answer is one string joined with `", "`.
    - Text and number questions take a reply; a number must be in range and on its steps.
    - A call in the chat goes to the dialog at the user's first touch (not in `/away` mode), on
      `/local`, or on its "🖥 Answer at the Mac" button.
    - A call left open at the Mac is reported once the user is away.
    - `PostToolUse` closes a call, and its text goes (D8).
  - **Routing:** a reply-to answers its question; a plain message goes to the only session that asks;
    the picker lists sessions that wait and sessions that ask.
  - **Presence** tells listeners of every change of state. While a question waits in the chat and the
    user is in between, it looks every second instead of every 5 s.
  - Gate: typecheck exit 0, "Checked 125 files", "532 pass, 0 fail", twice.
  - Positive controls, 12, 11 caught (failing tests):
    - a multi-select joined with "," (2);
    - no hand-over at the first touch (1);
    - numbers out of range accepted (2);
    - unconfirmed answers printed (1);
    - told twice of a question left open (1);
    - `/local` moving nothing (3);
    - lost answers not announced (1);
    - a reply-to ignoring its question (2, once a two-question test was added for it);
    - presence never hurried (2);
    - a released hook never told (4);
    - relayed while at the Mac (3).
  - The miss, a tap on an answered question accepted, is a doubled guard: without the database's
    guard 1 test fails, and without both, 2.
- **Going live:**
  - The live database was backed up at schema 3 (`VACUUM INTO`, 12 sessions):
    `.state/backups/broker.pre-schema4.2026-09-29T16-19-13Z.db` (0600).
  - `main` was fast-forwarded to `7fb7d4a`; the broker restarted on it (pid 27664, schema 4), and the
    sandbox's waiting hook carried over.
  - After the user's OK, they ran `bun run ctl install`: "installed 9 hooks", backup
    `settings.2026-09-29T16-26-23-331Z.json`.
  - Compared with the backup: nothing outside `hooks` changed, and the user's own 17 hooks in 14
    events are identical. Ours changed only in two places:
    - `PreToolUse` → `PreToolUse --wait`, timeout 10 → 43200, and a `statusMessage`;
    - `PostToolUse` on `AskUserQuestion` is new, so 8 hooks became 9.
- **Evidence** (broker log):
  - **The Codex checkpoint question from the phone** (`/away` on). The sandbox created `q.py`, and at its
    stop the checkpoint made Claude ask "Should Codex review the uncommitted change to q.py?" (Skip /
    Run Codex review).
    - The call went to the chat (16:29:13.436), and its ❓ went out at 16:29:13.848.
    - The user tapped Skip at 16:30:09.039. The call was answered and confirmed 3 ms later, and the
      hook printed the answer. `PostToolUse` closed the call at 16:30:09.149, and the ❓ was edited to
      "✅ Skip".
    - The sandbox's ✅ went out at 16:30:11.447. In its transcript the tool result reads "Your questions
      have been answered: …="Skip"", and Claude said "I skipped the Codex review, as you chose." No
      dialog opened.
  - **A bug, fixed** (`343a490`, deployed; broker pid 66299). The "✅ Skip" edit landed 455 ms after the
    tap, after the close, and saved the question's text in SQLite again. A message's text is now kept
    only while its call is open. A test lets an edit land after the close; its control is caught (1).
    Gate: "533 pass, 0 fail", twice. The live call's leftover text goes with the weekly prune: only the
    broker writes to its database.
  - **Leaving while a question is open at the Mac** (`/auto`). The sandbox asked "Do you prefer Red or
    Blue?"; the user was active, so the dialog opened at once (16:35:26.534, "at the Mac").
    - The user locked the screen. Presence turned away/locked at 16:36:23.945, and "❓ … has a question
      waiting at the computer", with the question and "It opened while you were at the Mac, so it can
      only be answered there", went out 0.45 s later (screenshot). It is sent once per call.
    - After unlocking, the user answered at the Mac: `PostToolUse` closed the call at 16:37:31.500, its
      text dropped.
- **Decisions (mine, open to change):**
  - A question in the chat goes to the dialog at the first touch after being away too, not only in
    between, so nobody faces a spinner at the desk; `/away` mode keeps it in the chat. Held or relayed,
    it can be answered in the chat.
  - `/local` hands back every question in the chat; each question also has a "🖥 Answer at the Mac"
    button.
  - A reply-to any message of a session that asks answers its first open question; a plain message
    goes to the only session asking.
  - A number may be typed with its unit ("35px"); it must lie in range and on the steps.
  - A call that can't be relayed (more than 4 questions, two alike, a choice with one option) goes to
    the dialog.
  - Presence looks every second only in between: one look costs about 52 ms of CPU, so away keeps 5 s.
- **Learned:**
  - 2.1.284's `AskUserQuestion` has a `title`, and `text` and `number` questions (F4); a hook's
    `statusMessage` shows in the spinner; the dialog can resolve itself after a stretch of idle, not seen
    live (F19).
  - A Telegram edit takes about 0.45 s, time enough for the next hook to arrive: anything saved after an
    await must still be wanted.
  - zsh doesn't split an unquoted `$VAR` into words (`${=VAR}` does); a test helper shared by several
    files must clean up at process exit, not in `afterAll`; an async function that returns a promise
    makes its caller wait for that promise; `contentModeFor` treats a folder that doesn't exist as
    ping-only, so tests need real folders.

## Next

Committed as `6ea4260` (2026-09-29). The user then decided: 4.2 is built, and O2 is yes, as the design
recommends (now D9: phase 5 is on).

## 4.2 Plans reviewed from the phone

- **Date:** 2026-09-30 (the live checks ran around midnight)
- **Result:** passed, after a change of design found live, with the user one small step at a time.
  A plan waiting for approval comes to the chat; from there it can be sent back for more planning, and
  it is approved in its dialog at the Mac.
- **Built first** (on `dev`, `13a7373`; design rev. 13, plan rev. 10): a plan relayed like a question
  (4.1's machinery), with Approve (the hook allows the call) and Keep planning (the hook denies it with
  the user's words).
  - The question hook matches `AskUserQuestion|ExitPlanMode`; the 🔐 ping skips ExitPlanMode.
  - After the user's OK, they ran `ctl install`; compared with the backup
    `settings.2026-09-29T18-37-34-251Z.json`, only our two matchers and the spinner text changed.
- **Found live:** Approve didn't approve.
  - The sandbox's plan came to the phone ("📋 … has a plan ready"), and the hook got it in its input
    (`hook.plan {from: "input", keys: "plan,planFilePath"}`, logged by `396315c`).
  - The user tapped Approve at 20:06:11.726, and the hook printed `allow` 3 ms later, but Claude Code
    opened its "Accept this plan?" dialog at the Mac anyway.
  - The 2.1.284 code shows why. After a hook's allow, Claude Code runs the tool's own permission check,
    and ExitPlanMode's always asks. A `PermissionRequest` hook's allow is ignored without `updatedInput`
    and re-asked with one. So no hook can approve a plan (F20); a deny still stops the call.
  - Following CLAUDE.md, this was stopped and put to the user: they chose to test the other hook. Its
    code path answered that (above), and they then chose "review on phone".
- **Built then** (`342d517`; design rev. 14, F20; plan rev. 11): the plan's only answer is Keep planning,
  or a reply with what to change, and the hook denies the call with those words. "🖥 Approve at the Mac"
  hands the plan to its dialog. No settings change was needed.
  - Gate: typecheck exit 0, "Checked 127 files", "546 pass, 0 fail", twice.
  - Positive controls, 8, each caught: a plan's answer allowed (1), a plan's Mac button as a question's
    (2), the plan dialog pinged too (1), a plan file read from anywhere (1, once its test used a real
    file), a plan shown as a question (1), one left open told as a question (1), a plan not read as one
    (5), a plan kept as questions (4).
- **Evidence** (`/away` on; broker log and the sandbox's transcript):
  - The user replied "Also print a second line: done" to the 📋 (stored at 20:29:59.673; a reply-to, so
    it answered that plan). The hook denied the call, and Claude got "PreToolUse:ExitPlanMode hook error:
    The user wants changes to the plan before approving it: Also print a second line: done".
  - Claude kept planning; the revised plan (361 characters, from 302) was in the chat at 20:30:05.
  - "🖥 Approve at the Mac" at 20:31:02.250: the hook stepped aside 1 ms later, the dialog opened at the
    Mac, and the user approved there. `PostToolUse` closed the call at 20:31:10.681.
  - `s.py` prints "s" and then "done". The stop's Codex ❓ was answered from the phone ("Skip"), and the
    ✅ went out at 20:31:26.783.
- **Decisions (the user's):** build 4.2; O2 yes, as D9; after F20, plans reviewed from the phone and
  approved at the Mac.
- **Learned:**
  - F20; and the hook's input does carry `plan` and `planFilePath` (2.1.284).
  - A denied call gets no `PostToolUse`: its record stays delivered until the session's next stop closes
    it.
  - The global CLAUDE.md's Codex checkpoints make Claude ask twice per planned change: before it presents
    a plan and at the stop after the change. In away mode each is a ❓ on the phone.

## Next

Committed as `5d85a97` (2026-09-30).

## 5.1 Permission prompts approved from Telegram

- **Date:** 2026-09-30 (built around midnight, live in the morning)
- **Result:** passed, with the user one small step at a time. While the user is away or in between, a
  permission prompt for Bash, Edit or Write in any session under `~` comes to the chat whole, with Allow
  once and Deny. At the Mac its dialog works as before.
- **Built** (on `dev`, `ac2e9b5`; design rev. 15):
  - **The permission hook** (`PermissionRequest`, installed with `--wait`: synchronous, timeout 12 h;
    `src/hooks/permission.ts`) runs beside the dialog (F5).
    - For Bash, Edit and Write it asks the broker as the question hook does (4.1's machinery), under an
      id of its own (`perm_<uuid>`: the request has no `tool_use_id`).
    - It prints Claude Code's decision: `allow`, or `deny` with a message for Claude. Any other tool, or
      without `--wait`: phase 2's 🔐 ping.
  - **The operation** (`src/broker/operation.ts`): the whole Bash command, where it runs and its
    description, or the file and the full change for Edit and Write, then every other field of the input.
    - Long ones go over up to four messages, or else as a file, `operation-<ref>.txt`, with a short note
      that carries the buttons.
    - The ref is the first 8 hex digits of a SHA-256 of the tool and its input. The buttons name the
      request's record, whose operation never changes once stored; the message and the audit log carry
      its ref.
  - **Answers** (`src/shared/permission.ts`): Allow once, Deny, or a reply, which denies with the user's
    words; "🖥 Answer at the Mac" hands it back, as for questions. Never "always allow".
  - **Stays at the Mac:** a tool outside the policy, a ping-only folder, a prompt with something that
    looks like a secret, and any prompt while the user is active.
  - **The audit log** (`.state/logs/audit.log`, 0600): every step of a relayed prompt (asked, answered,
    delivered, at the Mac, ended), by session, ask, tool and ref, never the text.
  - **Answered at the Mac:** Claude Code drops a hook's answer once the dialog has one. So when the turn
    moves on (the next prompt, or the stop), a prompt still in the chat reads "🖥 Answered at the Mac."
    and its hook stops.
  - Gate: typecheck exit 0, "Checked 134 files", "569 pass, 0 fail", twice.
  - Positive controls, 10, each caught (failing tests):
    - WebFetch in the policy (1);
    - an always-allow slipped in (1);
    - a reason dropped (1);
    - a secret relayed (1);
    - a prompt cut like a reply (1);
    - other fields hidden (1);
    - no file past four messages (1);
    - a stale prompt kept when the turn moves on (1);
    - decisions not audited (2);
    - a stranger's press taken (4).
  - The first control run found a real bug: the relay's cleanup could reject unhandled once its database
    had closed (a `.finally` after a failed edit). It now logs `ask.forget-failed`.
- **Going live:**
  - `main` was fast-forwarded to `ac2e9b5`, and the broker restarted on it (pid 85971, still schema 4). A
    waiting hook started it again the moment the old one stopped.
  - After the user's OK, they ran `bun run ctl install`: "installed 9 hooks", backup
    `settings.2026-09-30T05-52-11-678Z.json`.
  - Compared with the backup: nothing outside `hooks` changed, and the user's 17 hooks are identical and
    in order. Ours changed in one place: `PermissionRequest` → `PermissionRequest --wait`, timeout 10 →
    43200, no longer `async`.
- **Evidence** (`/away` on; audit and broker logs, the sandbox's transcript). The sandbox conversation,
  switched to "Ask before edits", was asked to run `npm test` (a script added to the sandbox for this):
  - Claude called Bash `npm test` at 05:58:21.155. The prompt reached the broker 79 ms later (ref
    `438bf823`), and went out as one message, nothing redacted or cut.
  - The user tapped Allow once; the answer was recorded at 05:58:45.410 (audit: allow, by telegram). It
    was delivered 5 ms later, and the hook logged `hook.permission {result: "answered"}`.
  - The dialog at the Mac closed by itself. The tool result, "sandbox tests: 3 passed", came at
    05:58:45.707, 0.3 s after the tap. The call closed when the turn ended (05:58:48.109).
- **Decisions (mine, open to change):**
  - A prompt goes over up to four messages, then as a file; it goes as a file at once when a line starts
    with ```, which can't sit whole inside a code block.
  - A prompt with something that looks like a secret stays at the Mac: it can't be both redacted (D8)
    and shown whole (D9).
- **Learned:**
  - A `PermissionRequest` hook's `allow` is taken for Bash, live, as the 2.1.284 code showed: F20 holds
    only for tools that need the user's interaction.
  - A running conversation picks up changed hooks without a restart: this check and 4.2's ran in a
    sandbox conversation started before either install.
  - In auto mode, the default in the user's settings, a classifier decides most calls without a dialog,
    so the check needed "Ask before edits".

## Next

Committed as `a3001e5` (2026-09-30).

## 6.1 Hardening and handover

- **Date:** 2026-09-30
- **Result:** passed. The pass check is a test with real processes; no settings change was needed, so
  the user had nothing to do.
- **Built** (on `dev`, `232efc9`):
  - **`ctl uninstall` in the order of design §6:** the disabled flag, then only our hooks, then the
    broker. `stopBroker` takes a broker that exits by itself on the way (it saw the flag) as stopped,
    instead of crashing on the signal. `ctl install` says so while the bridge is disabled.
  - **A race, found by the process test below:** hooks that start together each spawn a broker, and the
    losers wait up to 0.5 s for the lock. When the winner stopped within that time (uninstall), a loser
    got the lock after the flag was set: it ran its recovery and a Telegram poll before its flag watch
    stopped it. A broker now checks the flag again once it holds the lock.
  - **`ctl doctor`** (`src/ctl/doctor-local.ts`) also checks:
    - the broker: schema, token and environment;
    - the privacy of `.state/`: its folders 0700, what is in them 0600, the socket included;
    - our hooks, against what this version installs;
    - the Bun the hooks run;
    - whether the last 10 stops were read (F16), with the Claude Code versions they name. The Stop hook
      now logs the version from the stop's summary.
  - **Log rotation:** each `.state/logs/*.log` past 5 MB becomes `.1`, and 3 copies are kept. The broker
    does it at start and hourly; it alone rotates, so two rotations never race.
  - **`readSettings`** refuses a dangling symlink too; before, it read as "no file yet", so install
    would have replaced the link. A test meant to use such a link found it.
  - **`README.md`:** setup, pairing, daily use, commands, uninstall, security, troubleshooting, and the
    tested versions (a test keeps them in step with the doctor's).
  - Gate: typecheck exit 0, "Checked 141 files", "598 pass, 0 fail", twice.
  - Positive controls, 14, each caught by its own tests (failing tests):
    - the flag after the hooks (1);
    - no disabled flag (4);
    - the broker left running (2);
    - no flag check after the lock (1);
    - no rotation at start (1);
    - rotation overwriting `.1` (1);
    - rotated at the limit, not past it (2);
    - the state check skipping files (1);
    - hooks counted, not compared (1);
    - the rotated `hooks.log.1` unread (1);
    - untested versions unmarked (1);
    - the version dropped (2);
    - a dangling symlink replaced (1);
    - no note while disabled (1).
  - The first control run also showed a flaky assertion of mine: that the broker's last log line is
    `broker.started`, which presence can follow. The test now checks the order instead.
- **The pass check** (`tests/ctl/uninstall-process.test.ts`, 5 runs of 5 before the gate): real hooks and
  a real broker in a throwaway copy of the repo. The broker is paired and in away mode, and talks to a
  stand-in for the Bot API. The settings file lies in the copy.
  - Before uninstall: a Stop waiter, a question held in the chat and a Bash permission prompt, all
    waiting (the ✅, ❓ and 🔐 were sent), and the settings edited after install (a setting and a hook of
    the user's own).
  - `uninstallBridge` set the flag, removed our 9 hooks and stopped the broker, in that order.
  - Each hook exited 0 with nothing on stdout (no answer, no decision) and nothing on stderr (no wake).
    - The Stop hook's reason: "disabled".
    - The others: "disabled" or "no broker", depending on whether the stopping broker's answer reached
      them first.
  - Only ours went; the edit stayed. No broker started again (looked 2.5 s later), and a new
    `SessionStart` hook did nothing.
- **Going live:**
  - `main` was fast-forwarded to `232efc9`. The broker restarted on it (pid 39328): a waiting hook
    started it 14 ms after the stop, and the race's other broker gave up on the lock, as designed.
  - `bun run ctl doctor` on the live setup: all 13 checks pass, exit 0.
- **Decisions (mine, open to change):**
  - Logs rotate past 5 MB and keep 3 copies, about 20 MB per log at most; `audit.log` too.
  - The doctor's stops check fails if any of the last 10 stops had no summary in time.
  - After an uninstall, `install` says the bridge is disabled rather than enabling it: a disable may
    have been deliberate.
  - No live uninstall rehearsal: the process test runs the real broker and hooks, and a live one would
    take the bridge away from every session on the Mac. It remains an option for the user.
- **Learned:**
  - A broker that loses the start race waits up to 0.5 s for the lock: long enough to outlive a winner
    that stops at once.
  - In a process test, pick the broker by its `/health`, not by `pgrep`, which can also list a race
    loser still waiting for the lock.
  - Both VS Code windows here still run Claude Code 2.1.283, as their stops' summaries say, though the
    2.1.284 extension is installed too.

## Next

Committed as `9b28532` (2026-09-30).

## 6.2 Full gate and the Codex review

- **Date:** 2026-09-30
- **Result:** passed. The implementation plan is complete.
- **The gate before the review** (`9b28532`): typecheck exit 0, "Checked 141 files", "598 pass, 0 fail"
  across 57 files, twice. None of the 212 tracked files holds token-shaped text or a name that must stay
  out; `.env`, `config.json`, `.state/` and `sandbox/` are ignored.
- **The review** (the user chose the whole project):
  - `codex review --base` the scaffold commit, run in a clean clone, so only tracked files could be read.
  - This repo's `.env` stayed at mode 000 the whole time, and a trap put it back: "[.env mode after:
    600]".
  - Saved as `~/.claude/codex-reviews/code-claude_telegram_integration-20260930-100835.md`.
- **Findings, 6: each confirmed in the code, and reproduced by a failing test before its fix.** None
  was rejected.
  1. [P1] Buttons, and the answer a tap leaves, weren't redacted (D8): an option holding a secret showed
     it on its button. Both are redacted now, the answer before it is cut; Claude still gets the option
     as written.
  2. [P1] Edit and Write prompts had the file's path only in the header, which `formatReply` cuts at 200
     characters even for a whole prompt. The body now opens with the whole path, and a path or folder
     with a backtick sends the operation as a file.
  3. [P2] Only a question's last message was linked to it: a reply to an earlier message of a long one
     went to the session's oldest waiting call. Schema 5 (`ask_parts`) links every message.
  4. [P2] Presence's first look told no one. A broker restarted while a question waited in the chat,
     with you at the Mac, kept it there until your state changed. The first look is told too.
  5. [P2] A late report (a stop, its result, idle) reopened a session that had ended. Only
     `SessionStart` and a typed prompt reopen one now.
  6. [P2] At start, a call whose messages never all went out waited in the chat unseen. It goes to the
     Mac now, as a failed send does.
- **The gate after the fixes** (`31d4269`): typecheck exit 0, "Checked 143 files", "606 pass, 0 fail"
  across 58 files, twice.
- **Positive controls, 10:** each fix undone alone, and each caught by its own test:
  - buttons showing secrets;
  - the answer's echo showing them;
  - an edit's path only in the header;
  - a write's path only in the header;
  - a backtick path in a code span;
  - only the last message linked;
  - the first look untold;
  - a late report reopening;
  - a late Stop reopening;
  - a never-sent call left in the chat.
- **Going live:**
  - The live database was backed up at schema 4 (`VACUUM INTO`, 13 sessions, 17 asks, integrity ok):
    `.state/backups/broker.pre-schema5.2026-09-30T06-57-25Z.db` (0600).
  - `main` was fast-forwarded to `31d4269`, and the broker restarted on it (pid 18639, schema 5).
  - `bun run ctl doctor` on the live setup: all 13 checks pass. The stops line now names Claude Code
    2.1.283.
- **Decisions (mine, open to change):**
  - All six were fixed, the P2s too: each was small and could be tested.
  - Finding 3 keeps a long prompt in up to four messages (the design) and links them all, rather than
    sending every long prompt as a file.
  - Finding 6 sends a never-sent call to the Mac rather than sending it again: that is what a failed
    send does, and it can't leave duplicate messages.
- **Learned:** a review of the whole project found gaps between modules that each module's tests
  couldn't see, such as display paths that went around the redaction.

## Next

Committed as `9654bdd` (2026-09-30). Then the user asked for the commands to show up in the bot, with a
menu and a guide: step 7.1 (plan rev. 12).

## 7.1 The bot's menu and a guide

- **Date:** 2026-09-30
- **Result:** passed, with the user one small step at a time.
- **Built** (on `dev`, `d77f5f0`; design rev. 16, plan rev. 12):
  - The paired chat gets the commands as its menu: `setMyCommands` with that chat's scope only, at every
    broker start and on pairing. Other chats see none. A failure is only logged; the next start tries
    again.
  - `/help`, and `/start` (which Telegram sends when a bot is first opened), answer with a guide: what
    comes to the chat (✅ ❓ 📋 🔐), how to answer it, when you count as away, and each command with its
    line. The menu and the guide share one list, so they can't drift apart.
  - "Paired ✅" now ends with "/help shows how."
  - Gate: typecheck exit 0, "Checked 143 files", "611 pass, 0 fail" across 58 files, twice.
  - Positive controls, 8, each caught (failing tests):
    - no menu on pairing (2);
    - a menu on any pairing attempt (1);
    - no menu at start (1);
    - the menu for every chat (2);
    - `/start` not the guide (1);
    - `/local` left out of the menu (1);
    - `/help` answering with the status (1);
    - any answer taken as the menu set (1).
- **Going live:** `main` was fast-forwarded to `d77f5f0`, and the broker restarted (pid 52237);
  Telegram accepted the menu 1.6 s later (`menu.set`). No settings or schema change.
- **Evidence** (the user's phone):
  - "/" listed the commands, each with its line.
  - The Menu button showed the same six.
  - `/help`, tapped in the menu, brought the guide.
- **Decisions (mine, open to change):**
  - The menu is for the paired chat only: a stranger who opens the bot sees no commands.
  - `/pair` isn't in it: it is used once, from `ctl pair`'s instructions.
  - The menu and the guide are in English, like the bot's other messages.

## Next

Committed as `876c2bb`, then D10 as `db98106` (2026-09-30). Then the user asked for sessions to be named by
their titles in the chat, not by their folders: step 7.2 (plan rev. 14).

## 7.2 Sessions named by their titles

- **Date:** 2026-09-30
- **Result:** passed, with the user one small step at a time.
- **Found first** (F21, design rev. 18): Claude Code writes a session's title into its transcript, and
  again every few turns.
  - `custom-title` holds the one you gave it, and `ai-title` the one it made; it shows
    `customTitle || aiTitle` (2.1.284 binary).
  - A new session may get its title only after its first turn: the sandbox's came at line 105 of its
    transcript, after its first stop.
- **Built** (on `dev`, `085a1e4`):
  - Every hook reads the title from the last 512 KB of its transcript and sends it with each call to the
    broker. The broker keeps the latest (schema 6), so a waiting hook's calls update it too.
  - Messages and the picker name a session by its title. Until it has one, the folder label stays.
  - A title is Claude's text (D8): redacted, one line, at most 60 characters. None is kept for a
    ping-only folder, and at each start the broker drops those of folders that config.json has since
    made ping-only.
  - In the picker, two sessions of the same title get the start of their id.
  - Gate: typecheck exit 0, "Checked 145 files", "624 pass, 0 fail" across 59 files, twice.
  - Positive controls, 10, each caught by its own tests:
    - the hooks sending no title;
    - the made title over yours;
    - the first title kept, not the latest;
    - the label ignoring the title;
    - a title not redacted;
    - a call without a title erasing it;
    - a ping-only folder's title kept;
    - waiting calls not updating it;
    - hidden titles kept at start;
    - same-title buttons alike.
- **Going live:**
  - The live database was backed up at schema 5 (integrity ok):
    `.state/backups/broker.pre-schema6.2026-09-30T07-30-51Z.db` (0600).
  - `main` was fast-forwarded to `085a1e4`, and the broker restarted on it (pid 94777, schema 6).
- **Evidence** (`/away` on): the sandbox conversation answered "Say hi", and its ✅ came as
  "✅ Hello.py markdown note" (07:32:00.749). The broker holds that title for the sandbox session, and
  "Claude Code ↔ Telegram bridge" for this one.
- **Decisions (mine, open to change):**
  - The title alone, without the folder or the id, as the user asked; the id is added only in the
    picker, and only when two sessions share a title.
  - At most 60 characters, and one line.

## Next

Committed as `33d6b2f` and pushed (2026-09-30). Then the user asked for a bot command that lists the open
sessions: step 7.3 (plan rev. 15).

## 7.3 `/sessions`

- **Date:** 2026-09-30
- **Result:** passed, with the user.
- **Built** (on `dev`, `21165b8`):
  - `/sessions` lists the open sessions, one line each, by the name messages use, with what each is
    doing. What needs you comes first:
    - ❓ 📋 🔐 asking you in the chat;
    - ✅ finished, waiting for your reply;
    - 🖥 a question, plan or permission prompt open at the Mac;
    - ⏳ working;
    - 💤 stopped.
  - A session is open until its SessionEnd, which a crash or a restart never sends. So only sessions
    whose Claude still runs are listed. Every hook's call now brings its parent pid (F18), and the
    broker keeps it with the session (schema 7), along with when a prompt last started a turn. A
    session from before this step, whose pid isn't known yet, is listed while a hook of it waits for
    you.
  - At most 30 lines; two sessions of the same title get the start of their id, as in the picker,
    which now shares that code.
  - `/sessions` is in the menu, after `/status`, so `/help` lists it too.
  - Gate: typecheck exit 0, "Checked 147 files", "634 pass, 0 fail" across 60 files, twice.
  - Positive controls, 11, each caught by its own tests:
    - every open session listed;
    - a waiting hook's Claude not looked at;
    - a question's Claude not looked at;
    - no order;
    - no limit on the lines;
    - the prompt time not recorded;
    - a call without a pid forgetting it;
    - any number taken for a pid;
    - ended sessions counted as open;
    - same-title sessions alike;
    - `/sessions` missing from the menu.
- **Decisions (mine, open to change):**
  - The pid from the hooks (F18), not Claude Code's own `~/.claude/sessions/<pid>.json`, which is
    undocumented.
  - A pid Claude has since reused could keep a crashed session listed. That needs a crash, then a new
    process with the same pid, so it is left as is.
  - A permission prompt answered at the Mac stays 🖥 until the turn stops, because no hook says it was
    answered.
  - No buttons at first; the user asked for them after the live check (7.4).
- **Going live:**
  - The live database was backed up at schema 6 (integrity ok):
    `.state/backups/broker.pre-schema7.2026-09-30T08-07-43Z.db` (0600).
  - `main` was fast-forwarded to `21165b8`, and the broker restarted on it (pid 79689, schema 7). It
    set the menu again (`menu.set`).
- **Evidence:**
  - The user sent `/sessions` from the phone (08:08:41, `command sessions` in the broker log) and saw
    the list.
  - The pids the hooks bring match Claude Code's own `~/.claude/sessions/<pid>.json`: 11654 for this
    session, on 2.1.284, and 70692 and 49538 for two others, on 2.1.283. So F18 holds on 2.1.284 too.
  - The sandbox session "Hello.py markdown note" is still open in the database (no SessionEnd came),
    but no Claude process runs it, so it isn't listed.

## Next

The user asked to pick a session from the list and send it a message that runs there: step 7.4 (plan
rev. 16).

## 7.4 Write to a session from `/sessions`

- **Date:** 2026-09-30
- **Result:** passed live, with the user (see "Going live" below).
- **Built** (on `dev`):
  - Under the list, a button for each session that can take a message: asking in the chat, waiting
    for your reply, at the Mac or working. A stopped session gets none: no hook of it waits, so nothing
    would wake it until it's used at the Mac. The Stop hook waits 12 h (F2).
  - A tap sends "✏️ Your message for …" with Telegram's reply box open on it (`force_reply`). The
    question is linked to the session in the outbox, like a notice, and says what the message will do:
    - go in at once;
    - answer its question;
    - change its plan;
    - deny its permission, with the message as the reason;
    - or wait for the end of its turn.
  - What you type is then a reply to that question, and the router takes it to the session (flow 4),
    with no new routing.
  - A session that stopped, ended or whose Claude has gone since the list was sent gets a note on the
    tap. So does a button that can't be read.
  - The app tests' setup moved to `tests/helpers/app.ts`, so the `/sessions` tests have their own file.
  - Gate: typecheck exit 0, "Checked 152 files", "640 pass, 0 fail" across 62 files.
  - Positive controls, 10, each caught by its own tests:
    - no reply box;
    - the question not linked;
    - a stopped session asked for a message;
    - the tap left unanswered when the send fails;
    - the placeholder not cut;
    - one hint for every state;
    - stopped sessions given buttons;
    - no buttons at all;
    - taps not routed;
    - the gate dropping the buttons.
- **Decisions (mine, open to change):**
  - A question with the reply box, not "the next plain message goes to X". The reply box shows which
    session it's for, and the existing routing takes it, with no state to go stale.
  - No confirmation once the message has gone in: the session's next ✅ answers it, as after a reply
    to a ✅.

## Next

`main` moved to `7af6228` and the broker restarted on it; 7.4's live check is still to come. The user
then opened a new session, "IQ-1572", and `/sessions` didn't show it: step 7.5. Looking into that found
the broker killed along with a hook: step 7.6. The user approved both, with their doc changes (design
rev. 21: F21 refined, F22, D3; plan rev. 17).

## 7.5 Titles in `/sessions` as they are now

- **Date:** 2026-09-30
- **Found first:**
  - Claude Code wrote the new session's title, `ai-title` "IQ-1572", at 15:41:03, a second after its
    first prompt (15:41:02), whose hook had already run. The session's next hook came with the next
    prompt, at 15:46:57.
  - So both `/sessions` of 15:42 and 15:44 listed it by its folder, as "⏳ agent-panel-frontend … ·
    93c4: working", with its pid known and alive. F21 said a title may come only after the first turn;
    it can come during it, and a hook sees it only when it runs next (F21 refined).
- **Built** (on `dev`):
  - Hooks send the transcript's path with every call, and the broker keeps it with the session
    (schema 8). Only an absolute path of a `.jsonl` file is kept.
  - `/sessions` and a tap on one of its sessions read each running session's title from its
    transcript's end, with the code the hooks use, now in `src/shared/title.ts` (`readTail` in
    `src/shared/transcript.ts`). The title read is kept for the messages after.
  - Not for ping-only folders (D8), and not for sessions whose Claude has gone.
  - The real hook's process test now also checks that the transcript path and Claude's pid (its
    parent's, F18) reach the broker.
  - The app tests' harness waits, before each test, for the last test's pollers to stop and for the
    fake Bot API to answer any poll still pending. One such poll took the next test's update: the fake
    hands a queued update to whichever poll it reads first, which Telegram never does.
  - Gate: typecheck exit 0, "Checked 155 files", "647 pass, 0 fail" across 63 files, twice.
  - Positive controls, 9, each caught by its own tests:
    - hooks sending no transcript;
    - the broker dropping it;
    - any path taken;
    - a call without it forgetting it;
    - titles not read when listing;
    - ping-only transcripts read;
    - the title read not kept;
    - the title read ignored;
    - transcripts of gone sessions read.
- **Decisions (mine, open to change):**
  - The broker reads transcripts only for `/sessions` and its taps, and only their title entries.
    Notices keep the title their hooks read.

## 7.6 A broker no hook can take down

- **Date:** 2026-09-30
- **Found first** (F22, design rev. 21):
  - At 08:25:12.290 Claude Code stopped the Stop hook waiting for session `219eee4a`, at its 12 h
    timeout. The broker (pid 47544) got SIGTERM 6 ms later.
  - That hook had started the broker at 08:18:38, when `ctl stop` left no broker for the step 7.4
    restart. So the broker was still the hook's child, setsid or not.
  - Claude Code 2.1.284's `killProcessTree` lists every process (`ps -A -o pid= -o ppid=`) and kills
    the whole tree under the process it stops. Another waiting hook started a new broker at once
    (53265), so nothing was lost.
  - `ctl`'s own restarts, the other SIGTERMs in the log, were never near a hook's end.
- **Built** (on `dev`):
  - `src/broker/launch.ts`: started by `spawnBroker` (hooks and `ctl start`), it starts the broker
    with the same environment, folder and stderr, and exits at once, so launchd adopts the broker.
  - Both still run in a session of their own (setsid).
  - A process test starts a broker from a real waiting Stop hook, then kills the hook's tree as
    Claude Code does: every process under it by parent pid. The broker is not in the tree, still
    answers, and has launchd (1) as its parent.
  - The copy's `brokerPids()` skips the launcher, which names the broker's entry file for the moment
    it runs.
  - Gate: typecheck exit 0, "Checked 156 files", "648 pass, 0 fail" across 63 files, twice.
  - Positive controls, 2, each caught by the tree test:
    - no launcher, the hook being the broker's parent, as before;
    - a launcher that waits for the broker.

## Going live (7.5 and 7.6, 2026-09-30)

- The live database was backed up at schema 7 (integrity ok):
  `.state/backups/broker.pre-schema8.2026-09-30T16-06-04Z.db` (0600).
- `main` was fast-forwarded to `ab9efaa`. Two Stop hooks were waiting, started before 7.6 (pids 10845
  and 80151), so they still start a broker as their own child.
- The broker was handed over with a one-time script: start the new broker through the launcher, stop
  the old one, and let the brokers the old hooks start find the lock held.
  - **First try:** the old broker was stopped 200 ms after the start. The launcher itself took about
    0.2 s, so three brokers raced, and the one hook 10845 started got the lock: broker 11740, schema 8,
    whose parent was that hook. That's F22's setup, live.
  - **Second try:** the script waited for the new broker's own process before stopping the old one.
    Broker 13578 started at 16:06:44.273, schema 8, with launchd (1) as its parent. The two brokers the
    hooks started gave up ("another broker holds the lock"), and both waits were registered again.
- **Learned:**
  - The launcher adds about 0.2 s to a broker's start.
  - Hooks started before 7.6 still start brokers directly, until they end (at most 12 h).

- **7.4 live, passed** (16:26 to 16:27, broker 13578):
  - The user sent `/sessions`; "IQ-1572" was listed, and they tapped it (`write.asked`, working).
  - They then tapped this session (`write.asked`, listening) and wrote "Is your done?" in the reply box.
  - The broker routed it by the question's link to this session (`reply.routed` handed; `reply.confirmed`
    delivered: true). Claude woke with it (UserPromptSubmit 16:27:34.209).
  - Three sessions were waiting, so a plain message would have brought the picker; none came.

## Spike: a Claude Code tab opened from outside (asked 2026-09-30)

- **Asked:** can the bot open a new Claude Code tab in VS Code?
- **Found** (F23): the extension handles `vscode://anthropic.claude-code/open?prompt=…` (and
  `session=<id>`).
- **Tried** at 16:50:56 with `open` and a harmless prompt ("reply with just the word pong"):
  - VS Code opened a new Claude Code tab in the window used last, this repo's. A new process (66056)
    started session `061be445`: SessionStart at 16:51:12.
  - The prompt was only typed into the input box. It ran at 16:51:22, when sent at the Mac, and Claude
    answered "pong". The webview's only use of it is `setInputText`.
- **So:** from the phone, the link opens the tab, but nothing sends the prompt. A way to send it: open
  the tab without a prompt, and have the new session's SessionStart hook, run as `asyncRewake`, wake
  Claude with the prompt the way a reply goes in.
  - This needs a spike first: does `asyncRewake` wake a new session from SessionStart? F2 was proven on
    Stop.
  - It also needs a new hook entry, so a settings change with the user's OK.
- **The wake-up tested** (asked "run", 21:15 to 21:19; F24): Claude Code 2.1.284 was started the way
  the extension's SDK starts it (`--output-format stream-json --verbose --input-format stream-json`),
  in the scratchpad (outside `~`, not served), with only a throwaway settings file.
  - A SessionStart hook with `asyncRewake` exited 2 after 2 s: no turn came, in 60 s. With the SDK's
    `initialize` sent first and a 6 s hook, `initialize` was answered only after the hook ended. So
    SessionStart hooks run to completion first, and their exit 2 is dropped: the first message, at
    12 s, got only its own answer.
  - In the same session, after that first turn, a Stop hook with `asyncRewake` exited 2 after 3 s, and
    Claude took a turn with no input ("pong-stop"), as F2 found in the panel.
- **So:** a tab opened from the phone can't be started working. What the bot can start is a session
  it runs itself, as the plan's `/new <repo> <prompt>` has it; you follow it and answer it from the
  chat, and can open it at the Mac later.

## 7.7 `/new`: a session started from the chat

- **Date:** 2026-09-30 (asked "go" after the spikes; design D11, plan rev. 18)
- **Found first** (F25, 23:05, throwaway hooks outside `~`, 2.1.274):
  - In `claude -p` a Stop hook installed with `asyncRewake` blocks. The process stays alive while the
    hook waits, and its exit 2 continues the session with its stderr as the next message.
  - A PermissionRequest hook's allow applies there too: the test's `touch` ran.
  - So the bridge's own hooks can run a session the broker starts, with no new hook.
- **Built** (on `dev`):
  - `/new` answers with a button for each folder offered: those of recent sessions, served for
    terminal sessions, showing Claude's text, and still there (at most 8). A tap sends "✏️ Your first
    message for a new session in …" with the reply box open, recorded in `starts` (schema 9).
  - The reply to it starts `claude -p --session-id <id>` in that folder, through your login shell
    (`zsh -l -c 'exec claude …' "$1"`), with the message on stdin, marked "📨 From … on Telegram".
    - It runs in a session of its own (setsid), with the minimal environment plus the entrypoint
      `cli`.
    - Its stderr goes to `.state/logs/sessions.log`; its stdout goes nowhere, since the hooks send
      what Claude says.
  - The session is recorded before it starts, as started from the chat (`sessions.from_chat`):
    - its notices and questions go to the chat wherever you are (not with `/off`);
    - nothing hands its questions back to the Mac, where it has no dialog;
    - `/sessions` marks it "(started here)".
  - At most 3 run at once. A question takes one reply, within 30 minutes. A start that fails, or a
    process that exits with an error, is told in the chat. Every start goes to `audit.log`, by session
    and folder, never the message.
  - A delivered reply now marks its session as working, since `claude -p` sends no UserPromptSubmit
    when a reply continues it.
  - `askParts` and `replyParts` moved to `src/broker/app-parts.ts`, which kept `app.ts` under 300
    lines.
  - Gate: typecheck exit 0, "Checked 164 files", "668 pass, 0 fail" across 67 files, twice.
  - Positive controls, 15, each caught by its own tests:
    - notices ignoring where the session started;
    - questions ignoring it;
    - its questions handed back to the Mac;
    - a delivered reply leaving it stopped;
    - replies to /new questions not routed;
    - ping-only folders offered;
    - unserved folders offered;
    - no limit;
    - the message not marked;
    - the session not recorded as started here;
    - a question starting twice;
    - the session given the broker's whole environment;
    - not in a session of its own;
    - an error exit not told;
    - the "(started here)" mark missing.
- **Decisions (mine, open to change):**
  - It runs as a terminal session (`cli`), so `config.json`'s `entrypoints` must serve those. If they
    don't, `/new` says so.
  - No `/end` yet: a session ends 12 h after its last turn, when its Stop hook stops waiting.
  - The 🖥 button stays on its questions, and a tap says the session has no dialog at the Mac.
- **Going live** (19:50):
  - The live database was backed up at schema 8 (integrity ok):
    `.state/backups/broker.pre-schema9.2026-09-30T19-50-01Z.db` (0600).
  - `main` was fast-forwarded to `5cf9b34`. The new broker runs at schema 9 and set the menu with
    `/new`.
  - The handover script lost the race twice to brokers that the two hooks started before 7.6 (80151,
    10845) start directly. SQLite doesn't queue those waiting for a lock: a newcomer 26 ms after the
    stop took it while the waiting broker slept between tries.
  - So broker 43820 runs as hook 10845's child until that hook ends, at 03:12Z at the latest. Then it
    goes too, and the next hook starts one through the launcher.
- **Live check, first try** (20:23): it failed.
  - `/new` offered the three folders known to the bridge. The user tapped `agent-panel-frontend`, then
    `sandbox`: both starts failed with `Executable not found in $PATH: "unknown"`.
  - The shell came from Bun's `os.userInfo().shell`, which is `$SHELL`, and the broker has none (F26).
  - The user also didn't recognize their two VS Code windows in the list. They are this repo and the
    workspace `insureq-studio`, whose Claude sessions run in `agent-panel-frontend`; the list names
    folders.
- **Fixed** (on `dev`): the broker reads your login shell from the user database (`dscl`), once at
  start, and uses it only if it's an absolute path to an executable file (else `/bin/zsh`).
  - A test runs the lookup in the broker's own environment and checks it matches the user database.
  - Positive controls, 2, each caught: the old `userInfo().shell`, and any path taken for a shell.
- **Found too** (O4): the home folder that hooks and ctl resolve `~/` with also comes from `$HOME`, not
  from the user database as `paths.ts` says. Proposed to the user; not changed.
- **Live check, second try** (20:38): the session started, and nothing came back.
  - Session `fa5c0598` ran in the sandbox: Claude listed the files and it ended with code 0 after 15 s.
    None of its hooks reached the broker, so the chat only had "🚀 Starting…".
  - Its transcript records the entrypoint `sdk-cli` 25 times: in `-p` mode Claude Code sets that itself,
    over the `cli` the broker gave it (F27). The hooks serve only `cli` and `claude-vscode`, so they did
    nothing.
  - The user also asked to pick among their open VS Code windows (2026-10-01). They have two:
    `claude_telegram_integration`, and the workspace `insureq-studio`. `sandbox` is closed.
- **Changed** (on `dev`, design rev. 26):
  - `/new` offers the windows VS Code has open, read from its window state (F28), only while VS Code
    runs. A workspace's session runs in its first folder, with the others as `--add-dir`, as its
    window's do. On this Mac: `insureq-studio`, in `agent-panel-frontend` with 19 more folders, and
    `claude_telegram_integration`.
  - The broker puts the session's id in its environment (`CLAUDE_TELEGRAM_SESSION`). A hook serves a
    session whose environment names its own id, whatever its entrypoint; a stranger `sdk-cli` session
    stays unserved.
  - Gate: typecheck exit 0, "Checked 166 files", "678 pass, 0 fail" across 68 files, twice.
  - Positive controls, 9, each caught:
    - the hooks ignoring the id;
    - any id serving;
    - the id not given;
    - a workspace's folders not added, in the command and when started;
    - a closed VS Code's windows offered;
    - a workspace run in its last folder;
    - comments left in a workspace file;
    - unserved windows offered.
- **Live check, third try** (2026-10-01, 23:21 and 23:53 UTC): the hooks reached the broker, and still no ✅.
  - Both sessions' stops came out `unknown`, 30 s after the Stop, so no ✅ was sent. An unknown stop
    waits for idle_prompt, which `-p` never sends.
  - In `-p` the Stop hook blocks, and Claude Code writes the `stop_hook_summary` it waits for only
    after it (F29): the transcripts end at the assistant's text.
  - The user also still expects a VS Code tab: `/new` runs the session in the window's folder, not as a
    tab.
- **Fixed** (on `dev`, hooks only): a session /new started (its id in its environment) has its stop
  counted as a finish at once.
  - Tests: the handler, and a real hook as `sdk-cli` with the id and a transcript without the summary.
  - Positive controls, 2, each caught: the stop classified from the transcript, and `main.ts` not
    passing the flag.
- **Live check, fourth try** (00:57 UTC): session `1c894489` ran and its stop was a finish at once, but
  the ✅ was skipped as `muted`. The bot was in `/off`, which by D11 muted sessions started from the
  chat too. The user also still saw no VS Code tab, as D11 says.
- **Changed** (on `dev`): `/off` no longer mutes a session started from the chat, its notices or its
  questions; it mutes the rest as before (D11 amended).
  - Positive controls, 2, each caught: `/off` muting its notices, and sending its questions to the Mac.
- **Looked into:** `--session-mirror`, which the extension can pass, emits transcript frames for an SDK
  session store; it doesn't let a tab follow a session that runs elsewhere. A VS Code tab still can't
  show a `/new` session while it runs.
- **Live check, fifth try, passed** (12:25 UTC, broker 35230, bot in `/off`): `/new` in
  `claude_telegram_integration`, "list the files here". Session `c40d2df5` started at 12:25:45, its stop
  was a finish at 12:26:02 and the ✅ with the list was sent at 12:26:04 (`notice.sent`, mode full).
  The user saw no tab on the Mac, and still wants one.

## Spike: a new tab started working by its SessionStart hook (2026-10-01)

- **Found** in 2.1.285's binary (2.1.284's has it too): a SessionStart hook's output can carry
  `hookSpecificOutput.initialUserMessage`. In the SDK's mode, which the VS Code tab uses, Claude Code
  puts it before any other input (`prependUserMessage`). F24 tried only exit 2 and `asyncRewake`.
- **Tried** at 12:49 UTC, headless: 2.1.285 started the way the extension starts it, in the scratchpad
  (outside `~`), with only a throwaway settings file whose SessionStart hook printed the message. Nothing
  else was sent but `initialize`.
  - The hook ran at 5.5 s, the session answered "pong-init" at 8.3 s, and its Stop hook ran: one turn,
    with no input.
  - The stream showed no user message for it, only the answer.
- **So:** F24's conclusion, that no hook can start a new session working, is wrong. A tab opened with
  `vscode://anthropic.claude-code/open` could start working on the first message from the chat, given
  by the bridge's own SessionStart hook.
- **Not yet known**, for a live test: whether the tab shows that turn, and whether it opens in the
  window you picked (F23: the window used last).
  - A test tab with a throwaway hook in this repo's `.claude/settings.local.json` was blocked: auto mode
    doesn't let Claude write Claude Code's settings files. The user decides how to go on.

## Next

- **7.8's live check** (above).
- **Live checks still to come:**
  - 7.5: `/sessions` during a new session's first turn shows its title.
  - 7.6's live part: once a hook started after 7.6 has started a broker, its parent is launchd. The
    process test covers the hook's path.
- Push when the user asks: `origin/main` is at `33d6b2f`.
- A live uninstall rehearsal stays the user's choice (6.1 tested it with real processes).
