# Claude Code ↔ Telegram bridge

Hooks plus one local broker process that connect Claude Code sessions on this Mac (VS Code panel and
terminal) to a private Telegram bot chat: finished turns, questions and permission prompts go out, and
replies come back into the same session.

## Source of truth

Read these completely before doing anything in a new session:

1. [project-docs/design.md](project-docs/design.md): what and why. Platform facts F1–F18, architecture
   and flows 1–4, decisions D1–D8, open questions O2–O3, security, rollback, risks.
2. [project-docs/implementation-plan.md](project-docs/implementation-plan.md): the order of work, with a
   pass check for every step.
3. [project-docs/progress.md](project-docs/progress.md): steps done, their evidence, what we learned and
   what comes next.

## How we work (implementation-plan.md §1)

- One step at a time, each ending with a check you can see. Since 2026-09-28 (step 2.6) the user wants
  the work to go on by itself: commit a step once it passes and start the next. Stop only where the user
  has to act (a live check at the Mac or on the phone, the settings.json OK below, a decision that is
  theirs), and say exactly what to do.
- After each step, `project-docs/progress.md` records the step, date, result, the evidence line and what
  we learned, so a new session can pick up from there.
- Hooks in `~/.claude/settings.json` apply to every Claude session on this Mac. At the phase 2 checkpoint
  (2026-09-29) the user chose to serve all of `~` (`config.json`), this build session included. The hooks
  run this working copy's code, so it must always hold a step that passed:
  - New work happens in a git worktree, `../claude_telegram_integration-dev` on branch `dev`, tested there.
  - When its gate passes, fast-forward `main` here to it and restart the broker; then the live check.
  - A live check that fails is fixed in the worktree and fast-forwarded again.
  - Phase 3 moves `main` only at 3.3, with its install and live check: its schema 3 would stop phase 2's
    code from opening the broker's database, so a half-built phase 3 must not reach the live broker.
- When the user has to act, give one small step per message and wait for them before the next.
- Strict TypeScript with no `any`; files ≤ 300 lines, functions ≤ 50; an `unhandledRejection` handler in
  every entry point; no silent catches (log with context).
- A step is done only when `bun run typecheck`, `bun run lint` and `bun test` pass and its live check
  passes.
- Codex reviews are paused until the project is done; then the user decides whether to run one. When
  the Codex checkpoint hook fires, don't ask; never run Codex without the user's OK.

## Rules for this repo

- Reply in English, even when the user writes in Farsi.
- Never ask the user to paste the bot token into the chat. When `.env` is needed, create it from
  `.env.example` (mode 0600) and tell the user to fill in the token themselves. Never print `.env` or read
  it into the conversation either. Search or scan for secrets only in tracked or staged files
  (`git ls-files`, `git diff --cached`), never the whole working tree, which holds `.env`.
- Codex reviews can read any file in the repo, and what they read goes to OpenAI. Run each one with
  `.env` locked: `chmod 000 .env` right before it and `chmod 600 .env` right after, in the same command
  with a trap so the unlock also runs if the review fails; then check the mode is 600 again.
- Before any change to `~/.claude/settings.json`: back it up (to `.state/backups/`), show the user the
  exact entries to be added or removed, and wait for their OK. Then the user runs `bun run ctl install`
  (or `uninstall`) themselves, which makes the backup: Claude Code's auto mode doesn't let Claude write
  its own settings file. Afterwards, check the result against the backup.
- If a doc turns out wrong or a spike fails, stop and propose the change to the docs before working
  around it.
- When a step passes, commit it locally (no confirmation needed). No git remote until the user chooses one
  (O3: local only for now).

## Commands

```bash
bun install            # dev dependencies (the network here is slow: allow a few minutes)
bun run typecheck      # tsc --noEmit
bun run lint           # biome check; warnings fail too
bun test               # bun:test, files in tests/
bun run ctl doctor     # checks config.json, .env and the bot (getMe); never shows the token
bun run ctl status     # broker running with this repo's token? paired? presence? also: start | stop
bun run ctl disable    # sets the disabled flag and stops the broker, until `ctl enable` (design §6)
bun run ctl pair       # a one-time code (10 min) to send the bot as `/pair <code>`
bun run ctl install    # our hooks into ~/.claude/settings.json, after a backup; --dry-run shows them
bun run ctl uninstall  # removes only our hooks (the user runs both; see the rules above)
bun scripts/record-stops.ts [claude]  # re-records tests/fixtures/transcripts/ (calls the Claude API)
```

In the bot chat (design D4): `/status` says where the bridge thinks you are and why, `/away` relays
everything until `/auto`, `/auto` decides from the idle time and the screen lock, `/off` mutes.

Tests that need a real broker, hook or ctl process run them in a throwaway copy of the repo
(`tests/helpers/repo-copy.ts`), never against this repo's `.state/` or `.env`.

## Layout

```
src/            hooks/ and broker/ (design §3), ctl/ (command line), shared/ (config, .env, scope,
                telegram/ client); paths come from the script's own location, never the cwd
tests/          bun:test
scripts/        helper scripts: the stop recorder and its throwaway Stop hook (plan 2.8)
project-docs/   design, plan, progress, spike findings
sandbox/        gitignored; open a second VS Code window here to test hooks live. Its own git repo, so
                the Codex hook sees changes made there
.state/         gitignored runtime state: SQLite, broker.sock, logs, settings backups
.env            gitignored, mode 600: the bot token; never read it into the conversation
config.json     gitignored: your settings; config.example.json holds the defaults used without it
```
