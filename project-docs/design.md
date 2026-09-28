# Claude Code ↔ Telegram: Design

Status: rev. 7, F17 the screen lock (rev. 6: O1 decided as D8; rev. 5: Codex review of the spike
changes, §8; rev. 4: spikes S1–S3; rev. 3: F14; rev. 2: Codex review) · 2026-09-28 · Repo:
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

Checked on 2026-09-27 against code.claude.com docs, then tested by spikes S1–S3 on 2026-09-28 on this
Mac (CLI 2.1.274, VS Code extension 2.1.283); details in [spike-findings.md](spike-findings.md).

| # | Fact | Source |
|---|---|---|
| F1 | `Stop` input carries `last_assistant_message`, `stop_hook_active` and `background_tasks`. | hooks.md § Stop input |
| F2 | A command hook with `asyncRewake: true` runs in the background; if it exits 2, Claude wakes even when the session is idle (16 ms in the panel) and gets a user-role message, `Stop hook blocking error from command "Stop": <stderr>`, which it treats as a hook notice rather than your words. No 8-in-a-row cap; a wake during a busy turn is delivered right after it; the next Stop has `stop_hook_active: true`. A new local prompt does not stop a waiting hook. `timeout` has no maximum (43200 honoured) and is enforced with SIGTERM; closing the panel sends waiting hooks SIGTERM within 3 s. | hooks.md; S1 |
| F3 | A blocking `Stop` hook (`decision: "block"` + `reason`) continues the turn, capped at 8 in a row; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises the cap. | hooks.md § Stop decision control |
| F4 | `PreToolUse` on `AskUserQuestion` answers it with `permissionDecision: "allow"` + `updatedInput` = the original input + `answers` (`{question text: answer}`); no dialog appears, in the panel or the terminal. A free-text answer reaches Claude as the user's instruction. Send a multi-select answer as one string joined with `", "`: 2.1.274 passes a list through as `Bun,Biome`. Questions are `choice`, `text` or `number` (`min`, `max`, `step`, `unit`). | hooks.md; S2; 2.1.283 binary |
| F5 | `PermissionRequest` hooks return `decision.behavior` `allow` / `deny` (+ `message`, `interrupt`); exit 2 is ignored. They fire as the dialog opens, in the panel and the terminal, also for `AskUserQuestion`, whose dialog is a permission request. | hooks.md; S3 |
| F6 | `Notification` hooks observe only. `idle_prompt` fires 60 s after a real finish in the terminal, but **never in the VS Code panel**. `permission_prompt` came 6 s after a panel dialog opened, and not within 7 s in the terminal. | hooks.md; S3 |
| F7 | `UserPromptSubmit` gets the prompt you typed locally and may run synchronously (default timeout 30 s); a sync Bun hook delays the prompt by about 0.1 s at most. Every event carries `session_id`; `SessionEnd` hooks share a 1.5 s budget, with reason `other` (panel tab closed, end of `claude -p`) or `prompt_input_exit` (`/exit`). `StopFailure` fires when the API rejects a request. `claude -p` has no `AskUserQuestion`. | hooks.md; S3 |
| F8 | Telegram allows one `getUpdates` consumer per bot token (409 Conflict), and an update counts as confirmed once `getUpdates` is called with a higher `offset`. The official plugin kills the previous poller, so only one session can own the bot. | plugin `server.ts` L58–61; Bot API § getUpdates |
| F9 | Official channels start with `claude --channels …` in a terminal; the VS Code panel is not covered. | channels.md |
| F10 | Hooks run in the session's current directory and inherit its environment. `CLAUDE_CODE_ENTRYPOINT` is `claude-vscode` (panel), `cli` (terminal) or `sdk-cli` (`claude -p`). | hooks.md § Hook handler fields; S3 |
| F11 | `~/.claude/hooks/codex-checkpoint-code.sh` (Stop, 20 s timeout) blocks once per working-tree state, only for changes made during the session (`codex-baseline.sh` records the state at SessionStart), and makes Claude ask an `AskUserQuestion`. | read 2026-09-27 |
| F12 | `ioreg -c IOHIDSystem` → `HIDIdleTime` is the time since the last keyboard or mouse input, in **nanoseconds**. | observed |
| F13 | Bun loads `.env` from the current directory automatically; `bun --no-env-file` turns that off. | tested |
| F14 | Bun also loads `bunfig.toml` from the current directory and runs its `preload` scripts, even with `--no-env-file`. `--config=<file>` loads that file instead; a missing file stops Bun with exit 1. | tested 2026-09-28 (plan 1.2) |
| F15 | `CLAUDE_PROJECT_DIR` is the directory the session started in and stays there after a `cd`; the input's `cwd` follows the `cd`. | S3 |
| F16 | Each stop leaves a `stop_hook_summary` line in the transcript (`transcript_path`) once the synchronous Stop hooks finish, chained by `parentUuid` after the stop's last assistant message. When Claude Code continues the turn, it first writes a continuation entry into that chain: a `hook_blocking_error` attachment (after a meta "Stop hook feedback" message) or a `hook_additional_context` attachment; `preventedContinuation: true` ends the turn anyway. `hookErrors` also holds non-blocking errors, so it is not the signal. Seen in 2.1.274 and 2.1.283; undocumented. | 2.1.283 code; transcripts, 2026-09-28 |
| F17 | `ioreg -n Root -d 1`: the kernel's `IOConsoleLocked` is `Yes` while the screen is locked (also at the login window and on the way to sleep), and the console session in `IOConsoleUsers` then carries `CGSSessionScreenIsLocked`=Yes and `CGSSessionScreenLockedTime`. Unlocked, the flag is `No` and both keys are gone. This Mac locks itself after 30 minutes without input. | observed 2026-09-28 (plan 2.6) |

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
current directory (F10, F13, F14). Which sessions are served (the folder list, the skip list) is decided
by the directory the session started in, `CLAUDE_PROJECT_DIR`, never by the input's `cwd` (F15).
`ctl install` wires the hooks into `~/.claude/settings.json`, the only file changed outside this repo:

| Event | Matcher | Runs | Job |
|---|---|---|---|
| `SessionStart` | — | sync, ≤ 5 s | Register the session (start directory, branch, entrypoint); add the one-line note: messages starting "📨 Telegram reply from Hamed:" are Hamed's own replies, to treat as typed here (F2) |
| `UserPromptSubmit` | — | sync, ≤ 3 s | Cancel barrier: you typed locally, so this session's waiters are cancelled before the new turn starts |
| `Stop` | — | `asyncRewake`, timeout 12 h | Register a waiter; tell a real finish from a continuation by the stop's transcript entries (F16); on a Telegram reply, exit 2 with it |
| `Notification` | `idle_prompt` | `async` | Terminal only (F6): a second sign that the session is idle |
| `PermissionRequest` | — | `async` | "🔐 waiting for your permission" ping until phase 5; skips `AskUserQuestion` (F5, F6) |
| `StopFailure` | — | `async` | "⚠️ stopped on an API error" |
| `PreToolUse` | `AskUserQuestion` | sync, timeout 12 h | Ping (phase 2); relay and return the answers (phase 4) |
| `PostToolUse` | `AskUserQuestion` | `async` | Close a question that was answered at the computer |
| `PermissionRequest` | per policy | sync, timeout 12 h | Phase 5 only; never `AskUserQuestion` |
| `SessionEnd` | — | `async` | Mark the session ended, cancel its waiters |

Key flows:

1. **Turn finished → reply.** The Stop hook registers a waiter (a new generation for that session), then
   finds this stop's `stop_hook_summary` (F16): it reads the transcript's tail, so a summary written
   before the waiter started is found, skips a partial last line, takes the latest assistant entry whose
   text equals the input's `last_assistant_message`, and follows `parentUuid` from it to the first
   summary. The chain in between decides:
   - a continuation entry, without `preventedContinuation`: another hook, such as the Codex checkpoint,
     made Claude continue, so nothing is sent and the next stop decides;
   - anything else, including `hookErrors` from a hook that crashed: a real finish, so the
     "✅ `<repo>` · `<session>`" + final message goes out if you are away;
   - no summary within 30 s, or an unreadable format: unknown, so nothing is sent (D5) and the log says
     why; in the terminal `idle_prompt` still reports a finish.

   Background tasks such as a dev server don't hold the ✅ back; the message lists them. A Telegram reply
   resolves the waiter: the hook writes `📨 Telegram reply from Hamed: …` to stderr and exits 2, and
   Claude wakes up and continues. If a waiter gets SIGTERM (panel closed, timeout), it reports the end of
   its own generation and exits with no decision; the broker marks the session as not listening only
   when no newer waiter of it is live.
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
it waits, and the 8-in-a-row cap doesn't apply (S1: 10 of 10). Why a broker: several sessions wait at
once, but only one process may poll the bot (F8).

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
- **D4 Presence** as in flow 3: active < 30 s since your last input (F12); away after 3 min, when the
  screen is locked (F17), or on `/away`. An unreadable idle value counts as present, and `/status` shows
  it. Commands: `/away`, `/auto`, `/off` (mute), `/status`.
- **D5 Fail safe.** On any error the hook logs it and exits with no decision, so Claude behaves as if the
  hook were not there. Nothing is ever approved or answered because of an error.
- **D6 The Mac stays awake while you're away.** The display may sleep, the system may not; with the lid
  closed a MacBook sleeps unless it is on power with an external display.
- **D7 At-most-once delivery** (flow 4): a lost message is announced, and an instruction is never
  injected twice.
- **D8 What text leaves the Mac** (O1, decided with you on 2026-09-28 at plan step 2.5): Claude's final
  reply, redacted, up to about 3,500 characters in the chat. A longer reply gets a button that sends the
  full text, redacted, as a `.md` file. Folders listed in `config.json` (`content.pingOnly`) get pings
  only. Bot chats are Telegram cloud chats, not end-to-end encrypted, so that text is stored by
  Telegram.

Open, needed at the plan step shown:

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
- Outbound text is redacted and capped (D8). Logs hold ids and sizes, not message text.
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
| `asyncRewake` behaves differently in the VS Code panel | Proven in S1 (panel 2.1.283); fixtures + `ctl doctor` catch changes |
| Claude doesn't follow the reminder as your instruction | S1: it obeys but reads it as a hook notice, so the 📨 label + the SessionStart note |
| The VS Code panel ignores injected answers | Proven in S2 (panel and terminal) |
| Local typing and a Telegram reply cross | Sync cancel barrier, one transaction per waiter; a hand-over that can't be recalled is reported |
| A question already open locally can't be answered from Telegram | In-between hold (flow 3); "waiting at the computer" message |
| A window reload kills waiting hooks, so late replies can't be delivered | S1: SIGTERM within 3 s; the waiter tells the broker, the bot says the session is no longer listening, and the next turn's Stop starts a new waiter |
| The undocumented `stop_hook_summary` changes | Recorded transcript sequences as fixtures, live checks before the served folders widen (plan 2.8), a `ctl doctor` check; an unknown result sends no ✅ (D5), and the terminal keeps `idle_prompt` |
| A session `cd`s into a served folder | Scope by `CLAUDE_PROJECT_DIR` (F15) |
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

Spikes S1–S3, 2026-09-28 ([spike-findings.md](spike-findings.md)); changes agreed with you at plan step 1.5.

| Spike | Finding | Change |
|---|---|---|
| 1.2 | Bun loads the session directory's `bunfig.toml` and runs its preload | F14; hooks pass `--config` (§3, §5; plan 2.3, 2.7) |
| S1 | `asyncRewake` wakes the idle panel, no 8-cap, queued while busy, SIGTERM when the panel closes | F2 verified; the waiter reports SIGTERM (flow 1; plan 3.1) |
| S1 | Claude reads a wake as a hook notice, not your words | SessionStart note (§3 table; plan 2.7) |
| S2 | A hook answers `AskUserQuestion`; versions join lists differently; text and number questions exist | F4 verified; one joined string; question kinds (plan 4.1) |
| S3 | No `idle_prompt` in the panel | F6 corrected; a real finish is read from the stop's summary, F16 (flow 1; plan 2.7, 2.8) |
| S3 | `cwd` follows `cd`; `CLAUDE_PROJECT_DIR` keeps the start directory | F15; scoping by it (§3; plan 2.1, 2.7) |
| S3 | `permission_prompt` is late in the panel and absent in the terminal | The 🔐 ping moves to an async `PermissionRequest` hook (§3 table; plan 2.7) |

Codex plan review of rev. 4, 2026-09-28 (`~/.claude/codex-reviews/plan----20260928-054822.md`): UNSOUND,
3 findings, all confirmed (the first in the 2.1.283 code and real transcripts) and fixed in rev. 5.

| # | Finding | Change |
|---|---|---|
| 1 | `hookErrors` also holds non-blocking errors, and `additionalContext` continues without it | Classify by the continuation entries in the stop's chain; unknown sends nothing (F16, flow 1) |
| 2 | "This stop's summary" had no correlation rule; reading from EOF misses early summaries | Tail read, match `last_assistant_message`, follow `parentUuid`; tests and live checks before the served folders widen (flow 1; plan 2.8) |
| 3 | A SIGTERM from an old waiter could mark a live session as not listening | Termination ends only that waiter's generation; recorded on disk if the broker is down (flow 1; plan 3.1) |
