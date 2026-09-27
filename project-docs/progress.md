# Progress

The log of [implementation-plan.md](implementation-plan.md), newest step last. Each entry records the
date, the result, the evidence and what we learned. A new session reads this, then continues at **Next**.

## Phase 0: prerequisites (the user)

| Item | Status |
|---|---|
| 0.1 Bot created with BotFather | not stated yet |
| 0.2 Telegram two-step verification | not stated yet |
| 0.3 O3 git remote | local only for now (2026-09-27) |
| 0.3 D6 how the Mac stays awake | not stated yet |

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

## Next

**1.2 Spike S1** (wake an idle VS Code session), after the user's go. It changes
`~/.claude/settings.json`: back up first, show the exact entries, wait for the user's OK.
