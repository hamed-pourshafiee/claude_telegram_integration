# Claude Code ↔ Telegram: Design

Status: rev. 3, F14 added in plan step 1.2 (rev. 2: Codex review, §8) · 2026-09-28 · Repo:
`/Users/hamed/src/bc/claude_telegram_integration`

The steps that build this are in [implementation-plan.md](implementation-plan.md).

## 1. Goal

When a Claude Code session on this Mac (the VS Code panel or a terminal `claude`) needs you while you are
away from the computer:

| When | Telegram shows | You can |
|---|---|---|
| Claude finishes a turn | ✅ + Claude's final message | Reply with text; the same session continues |
| Claude asks a question (`AskUserQuestion`) | ❓ + the options as buttons | Tap an option or type your own answer |
| Claude needs a tool permission | 🔐 + the tool and what it will do | Get pinged (phase 2); Allow once / Deny (phase 5, opt-in) |

Your constraints: Telegram only, no Remote Control; all code and docs live in this repo.

Out of scope: the official Telegram channel plugin (see D1), starting new sessions from Telegram,
Windows/Linux.

## 2. Platform facts

Checked on 2026-09-27 against code.claude.com docs and on this Mac (CLI 2.1.274, VS Code extension
2.1.283). Items marked **spike** are documented but not yet proven in the VS Code panel; phase 1 proves
them before anything is built on them.

| # | Fact | Source |
|---|---|---|
| F1 | `Stop` input carries `last_assistant_message`, `stop_hook_active` and `background_tasks`. | hooks.md § Stop input |
| F2 | A command hook with `asyncRewake: true` runs in the background; if it exits 2, Claude wakes immediately even when the session is idle and sees the hook's stderr as a system reminder. `timeout` is enforced for it (default 600 s). **spike** | hooks.md § Command hook fields, § Run hooks in the background |
| F3 | A blocking `Stop` hook (`decision: "block"` + `reason`) continues the turn, capped at 8 in a row; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises the cap. | hooks.md § Stop decision control |
| F4 | `PreToolUse` on `AskUserQuestion` answers it with `permissionDecision: "allow"` + `updatedInput` = the original `questions` + `answers` (`{question text: option label}`, multi-select joined with commas). **spike** | hooks.md § AskUserQuestion |
| F5 | `PermissionRequest` hooks return `decision.behavior` `allow` / `deny` (+ `message`, `interrupt`); exit 2 is ignored. The docs imply they run in VS Code sessions. **spike** | hooks.md § PermissionRequest, § Notification |
| F6 | `Notification` hooks observe only. `idle_prompt` fires about 60 s after Claude has really finished, after any Stop-hook continuation, if nobody typed. Not yet seen in the VS Code panel. **spike** | hooks.md § Notification |
| F7 | `UserPromptSubmit` gets the prompt you typed locally and may run synchronously (default timeout 30 s). Every event carries `session_id`; `SessionEnd` hooks share a 1.5 s budget. | hooks.md |
| F8 | Telegram allows one `getUpdates` consumer per bot token (409 Conflict), and an update counts as confirmed once `getUpdates` is called with a higher `offset`. The official plugin kills the previous poller, so only one session can own the bot. | plugin `server.ts` L58–61; Bot API § getUpdates |
| F9 | Official channels start with `claude --channels …` in a terminal; the VS Code panel is not covered. | channels.md |
| F10 | Hooks run in the session's current directory and inherit its environment; VS Code sessions have `CLAUDE_CODE_ENTRYPOINT=claude-vscode`. | hooks.md § Hook handler fields; observed |
| F11 | `~/.claude/hooks/codex-checkpoint-code.sh` (Stop, 20 s timeout) blocks once per working-tree state, only for changes made during the session (`codex-baseline.sh` records the state at SessionStart), and makes Claude ask an `AskUserQuestion`. | read 2026-09-27 |
| F12 | `ioreg -c IOHIDSystem` → `HIDIdleTime` is the time since the last keyboard or mouse input, in **nanoseconds**. | observed |
| F13 | Bun loads `.env` from the current directory automatically; `bun --no-env-file` turns that off. | tested |
| F14 | Bun also loads `bunfig.toml` from the current directory and runs its `preload` scripts, even with `--no-env-file`. `--config=<file>` loads that file instead; a missing file stops Bun with exit 1. | tested 2026-09-28 (plan 1.2) |

## 3. Architecture

```
 Claude Code sessions (VS Code panel, terminal), in any repo
   │  hook events (JSON on stdin)
   ▼
 <repo>/src/hooks/   short-lived: bun --no-env-file --config=<repo>/bunfig.toml <repo>/src/hooks/main.ts <event>
   │  HTTP over a Unix socket: <repo>/.state/broker.sock (0600)
   ▼
 <repo>/src/broker/  one long-running Bun process, started with a minimal environment
   ├─ the only Telegram poller (long-poll getUpdates)
   ├─ durable inbox + routing: Telegram message ↔ session ↔ pending request
   ├─ presence: active / in between / away
   ├─ formatting: redaction, HTML escaping, 4096-char chunks
   └─ state: SQLite (bun:sqlite) in <repo>/.state/
   │  HTTPS
   ▼
 Telegram Bot API ⇄ your private chat with the bot
```

`<repo>` is this directory. Every path comes from the script's own location, never from the session's
current directory (F10, F13, F14). `ctl install` wires the hooks into `~/.claude/settings.json`, the only file
changed outside this repo:

| Event | Matcher | Runs | Job |
|---|---|---|---|
| `SessionStart` | — | sync, ≤ 5 s | Register the session (cwd, branch, entrypoint); one-line context note if phase 1 shows it's needed |
| `UserPromptSubmit` | — | sync, ≤ 3 s | Cancel barrier: you typed locally, so this session's waiters are cancelled before the new turn starts |
| `Stop` | — | `asyncRewake`, timeout 12 h | Register a waiter; on a Telegram reply, exit 2 with it |
| `Notification` | `idle_prompt` | `async` | The session is really idle: send the ✅ once you are away |
| `Notification` | `permission_prompt` | `async` | "🔐 waiting for your permission" ping until phase 5 |
| `StopFailure` | — | `async` | "⚠️ stopped on an API error" |
| `PreToolUse` | `AskUserQuestion` | sync, timeout 12 h | Ping (phase 2); relay and return the answers (phase 4) |
| `PostToolUse` | `AskUserQuestion` | `async` | Close a question that was answered at the computer |
| `PermissionRequest` | per policy | sync, timeout 12 h | Phase 5 only |
| `SessionEnd` | — | `async` | Mark the session ended, cancel its waiters |

Key flows:

1. **Turn finished → reply.** The Stop hook registers a waiter (a new generation for that session) and
   sleeps. The "✅ `<repo>` · `<session>`" + final message goes out when Claude Code itself reports the
   session idle (`idle_prompt`, about a minute after the finish) and you are away, so a stop that another
   hook blocked, such as the Codex checkpoint, never produces a false "finished". Background tasks such as
   a dev server don't hold it back; the message lists them. A Telegram reply resolves the waiter: the hook
   writes `📨 Telegram reply from Hamed: …` to stderr and exits 2, and Claude wakes up and continues.
2. **Typing locally vs a reply.** Cancelling (the sync `UserPromptSubmit`) and delivering (a reply) are
   competing SQLite transactions on the same waiter, and the first to commit wins. If you typed first,
   nothing is injected. If the reply was already handed over it can't be recalled; Claude still receives
   it, and the bot tells you it crossed with your typing.
3. **Question.** Presence has three states:
   - Active (input in the last 30 s): the local dialog opens at once.
   - Away (idle ≥ 3 min, screen locked, or `/away`): the question is relayed to Telegram.
   - In between: the question is held and pinged to Telegram, and goes to the local dialog the moment
     you touch the keyboard or mouse (the spinner says so).

   No hook can answer a dialog that is already open locally, so if you leave while one is open, the bot
   only tells you a question is waiting at the computer. `/away` sent from your phone as you leave makes
   everything relay at once.
4. **Routing and delivery.** Every bot message is linked to its session and request.
   - A reply-to goes to that session.
   - A plain message goes to the only waiting session; if several are waiting, the bot asks
     "Which session?"; if none, it says nobody is listening.
   - Messages sent while Claude is busy are queued for its next Stop.

   Updates are stored (unique `update_id`) before the Telegram offset moves on. Answers are bound to one
   request id and never reused. Each message is injected at most once; if a hand-over can't be confirmed,
   the bot says so instead of resending.

Why `asyncRewake` rather than a blocking Stop hook: the session stays idle and usable at the desk while
it waits, and the 8-in-a-row cap probably doesn't apply (spike S1 checks). The blocking hook is the
fallback if the spike fails. Why a broker: several sessions wait at once, but only one process may poll
the bot (F8).

## 4. Decisions

Taken (say so before the step if you disagree):

- **D1 Own hooks + broker, not the official channel plugin.** The plugin needs a terminal session started
  with `--channels`, serves one session at a time (F8, F9), and its code lives outside this repo.
- **D2 Bun + strict TypeScript.** Hooks start in tens of milliseconds, TS runs without a build, and SQLite
  and Unix-socket HTTP are built in. Checks: `tsc --noEmit`, Biome lint, `bun test`. No Telegram library:
  a handful of Bot API calls go over `fetch`.
- **D3 Hooks start the broker on demand** from `<repo>`, with a minimal environment, so inherited
  variables such as `BUN_CONFIG_VERBOSE_FETCH` can't log token-bearing URLs. No launchd plist. A
  persistent "disabled" flag stops every hook, waiter and restart.
- **D4 Presence** as in flow 3: active < 30 s since your last input; away after 3 min, when the screen is
  locked, or on `/away`. An unreadable idle value counts as present, and `/status` shows it. Commands:
  `/away`, `/auto`, `/off` (mute), `/status`.
- **D5 Fail safe.** On any error the hook logs it and exits with no decision, so Claude behaves as if the
  hook were not there. Nothing is ever approved or answered because of an error.
- **D6 The Mac stays awake while you're away.** The display may sleep, the system may not; with the lid
  closed a MacBook sleeps unless it is on power with an external display.
- **D7 At-most-once delivery** (flow 4): a lost message is announced, and an instruction is never
  injected twice.

Open, needed at the plan step shown:

- **O1 (step 2.5) How much text leaves the Mac.** Recommended: the full reply, redacted, capped at
  ~3,500 characters, with the rest sent as a `.md` file on request. Alternative: ping-only for chosen
  repos. Bot chats are Telegram cloud chats, not end-to-end encrypted, so company code or customer data
  in a reply is stored by Telegram.
- **O2 (phase 5) Remote permission approval at all.** If yes, recommended: Allow once only, for Bash, Edit
  and Write; never for MCP tools or WebFetch; the complete operation shown; every decision in an audit log.
- **O3 (step 1.1) Git remote** for this repo: company GitLab, personal, or local only.

## 5. Security

- Only your paired Telegram user id, in a private chat, can do anything; everything else is dropped and
  logged.
- The token lives only in `<repo>/.env` (0600, gitignored) and is scrubbed from logs. The socket is 0600
  inside a 0700 `.state/`, and there is no TCP port.
- Hooks run with `--no-env-file --config=<repo>/bunfig.toml` and the broker with a minimal environment,
  so another repo's `.env`, its `bunfig.toml` preload or a stray variable never reaches our processes
  (F13, F14).
- Outbound text is redacted and capped (O1). Logs hold ids and sizes, not message text.
- Relayed replies are labelled as coming from Telegram, and only our hook can produce them.
- Remote approvals are opt-in, Allow once only, bound to what you saw, and audited (O2).
- Two-step verification on Telegram (plan step 0.2): a hijacked Telegram account would mean remote control
  of this Mac through Claude.

## 6. Rollback

`/off` in Telegram mutes everything. `ctl uninstall` runs in this order:

1. Sets the disabled flag: hooks exit at once, running waiters leave with no decision, and nothing
   restarts the broker.
2. Removes only our settings entries, keeping anything else you changed since install.
3. Stops the broker.

After that, deleting the repo leaves nothing behind; settings backups stay in `.state/backups/`.

## 7. Risks

| Risk | Mitigation |
|---|---|
| `asyncRewake` behaves differently in the VS Code panel | Spike S1 first; blocking Stop hook as fallback |
| Claude doesn't follow the reminder as your instruction | Explicit wording + the SessionStart note; checked in S1 |
| The VS Code panel ignores injected answers | Spike S2; deny-with-answer fallback |
| Local typing and a Telegram reply cross | Sync cancel barrier, one transaction per waiter; a hand-over that can't be recalled is reported |
| A question already open locally can't be answered from Telegram | In-between hold (flow 3); "waiting at the computer" message |
| A window reload kills waiting hooks, so late replies can't be delivered | The bot says the session is no longer listening; the next turn's Stop starts a new waiter |
| A Claude Code update changes hook inputs | Recorded fixtures + `ctl doctor`; the tested version is noted in the README |
| Noise with many parallel sessions | Away-only, per-session labels, `/off`; topics later |

## 8. Review log

Codex plan review, 2026-09-27 (`~/.claude/codex-reviews/plan-implementation-plan--20260927-210314.md`):
SOUND_WITH_CHANGES, 9 findings, all accepted after checking them against the docs and the hook scripts.

| # | Finding | Change |
|---|---|---|
| 1 | Async cancel can race a reply or hit a newer waiter | Sync `UserPromptSubmit` barrier, generations, competing transactions (flow 2; plan 3.1) |
| 2 | No durable delivery across crashes | Stored inbox before the offset moves, request-bound answers, at-most-once (flow 4, D7; plan 3.1–3.2) |
| 3 | Approvals showed only head + tail | Complete operation, bound to a hash (plan 5.1) |
| 4 | A 5 s grace can't tell a blocked stop from a finish | The ✅ waits for `idle_prompt`; the live test changes a file during the session (flow 1; plan 2.8) |
| 5 | A question shown just after you leave can't be taken over | Three presence states + "waiting at the computer" (flow 3; plan 4.1) |
| 6 | Skipping stops with background tasks silences sessions running a dev server | Never skip; list the tasks (plan 2.7) |
| 7 | Paths and env depend on the session's directory; Bun loads that repo's `.env` | Anchored paths, `--no-env-file`, minimal broker env (D3, F13; plan 2.3) |
| 8 | `HIDIdleTime` is nanoseconds, not seconds | F12 corrected; parser tests (plan 2.6) |
| 9 | Rollback ignored live waiters and later settings edits | Disable first; remove only our entries (§6; plan 6.1) |
