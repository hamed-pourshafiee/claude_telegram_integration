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
  in 0.4 s. Not seen literally: a `/status` sent while the Mac was locked (the user locked it and left);
  they are asked to confirm it at the next stop.
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

**2.7 Notify hooks + install**, which stops for the user's OK before `~/.claude/settings.json` changes;
at that stop, also ask them to send `/status` from the phone while the Mac is locked (2.6). The broker is
running and paired. `.env` holds the real token: scan only staged files, and lock `.env` during any Codex
review (CLAUDE.md).
