# Claude Code ↔ Telegram bridge

Hooks plus one local broker process that connect Claude Code sessions on this Mac (VS Code panel and
terminal) to a private Telegram bot chat: finished turns, questions and permission prompts go out, and
replies come back into the same session.

## Source of truth

Read these completely before doing anything in a new session:

1. [project-docs/design.md](project-docs/design.md): what and why. Platform facts F1–F14, architecture
   and flows 1–4, decisions D1–D7, open questions O1–O3, security, rollback, risks.
2. [project-docs/implementation-plan.md](project-docs/implementation-plan.md): the order of work, with a
   pass check for every step.
3. [project-docs/progress.md](project-docs/progress.md): steps done, their evidence, what we learned and
   what comes next.

## How we work (implementation-plan.md §1)

- One step at a time. Each step ends with a check you can see, and nothing starts until the user says go.
- After each step, `project-docs/progress.md` records the step, date, result, the evidence line and what
  we learned, so a new session can pick up from there.
- Hooks in `~/.claude/settings.json` apply to every Claude session on this Mac. Until the user widens it
  at the phase 2 checkpoint, everything we install acts only for sessions started in `<repo>/sandbox/`,
  never for the session doing the build or the user's other work.
- Strict TypeScript with no `any`; files ≤ 300 lines, functions ≤ 50; an `unhandledRejection` handler in
  every entry point; no silent catches (log with context).
- A step is done only when `bun run typecheck`, `bun run lint` and `bun test` pass and its live check
  passes.
- Codex review is offered after code steps: ask first, never run it automatically.

## Rules for this repo

- Reply in English, even when the user writes in Farsi.
- Never ask the user to paste the bot token into the chat. When `.env` is needed, create it from
  `.env.example` (mode 0600) and tell the user to fill in the token themselves. Never print `.env` or read
  it into the conversation either.
- Before any change to `~/.claude/settings.json`: back it up (to `.state/backups/`), show the user the
  exact entries to be added or removed, and wait for their OK.
- If a doc turns out wrong or a spike fails, stop and propose the change to the docs before working
  around it.
- When a step passes and the user confirms, commit it locally. No git remote until the user chooses one
  (O3: local only for now).

## Commands

```bash
bun install            # dev dependencies (the network here is slow: allow a few minutes)
bun run typecheck      # tsc --noEmit
bun run lint           # biome check; warnings fail too
bun test               # bun:test, files in tests/
```

## Layout

```
src/            hooks/ and broker/ (design §3); paths come from the script's own location, never the cwd
tests/          bun:test
scripts/        helper scripts
project-docs/   design, plan, progress, spike findings
sandbox/        gitignored; open a second VS Code window here to test hooks live
.state/         gitignored runtime state: SQLite, broker.sock, logs, settings backups
```
