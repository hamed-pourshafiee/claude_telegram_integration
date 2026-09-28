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

## Next

After the user confirms 1.3 and it is committed: **1.4 Spike S3** (record real hook inputs as test
fixtures), after the user's go. It adds a logging hook for every event in design §3's table, limited to
`sandbox/` sessions: back up, show the entries, wait for the OK. Don't change repo files while a sandbox
conversation runs (the Codex hook would react there, since the sandbox lives inside this repo).
