# Claude Code ↔ Telegram: Design

Status: rev. 21, F22: Claude Code kills a hook's whole process tree, so the broker starts through a
launcher (D3, plan 7.6); F21: a title can come during the first turn, so `/sessions` reads titles as it
lists (plan 7.5) (rev. 20: D4, a tap on a session under `/sessions` writes to it, plan 7.4; rev. 19:
`/sessions` lists the open sessions, whose Claude still runs by F18, plan 7.3; rev. 18: F21, messages
name a session by its title, plan 7.2; rev. 17: D10, the git remote is GitHub, O3; rev. 16: the bot's
menu of commands and /help, plan 7.1; rev. 15: permission prompts in flow 3, phase 5, D9; rev. 14: F20,
no hook can approve a plan, so plans are reviewed from the phone; rev. 13: O2 decided as D9, plans in
flow 3; rev. 12: flow 3 as built in plan 4.1, F4 and F19 from 2.1.284; rev. 11: D8, Markdown shown as
formatting; rev. 10: F2, a wake fires UserPromptSubmit; rev. 9: F18 the hook's parent; rev. 8: F16 and
flow 1 from plan 2.8's recorded stops; rev. 7: F17 the screen lock; rev. 6: O1 decided as D8; rev. 5:
Codex review of the spike changes, §8; rev. 4: spikes S1–S3; rev. 3: F14; rev. 2: Codex review) ·
2026-09-30 · Repo: `/Users/hamed/src/bc/claude_telegram_integration`

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
| F2 | A command hook with `asyncRewake: true` runs in the background; if it exits 2, Claude wakes even when the session is idle (16 ms in the panel) and gets a user-role message, `Stop hook blocking error from command "Stop": <stderr>`, which it treats as a hook notice rather than your words. No 8-in-a-row cap; a wake during a busy turn is delivered right after it; the next Stop has `stop_hook_active: true`. A new local prompt does not stop a waiting hook. `timeout` has no maximum (43200 honoured) and is enforced with SIGTERM; closing the panel sends waiting hooks SIGTERM within 3 s. The wake also fires `UserPromptSubmit`, about 0.1 s after the hook exits. | hooks.md; S1; plan 3.3 |
| F3 | A blocking `Stop` hook (`decision: "block"` + `reason`) continues the turn, capped at 8 in a row; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises the cap. | hooks.md § Stop decision control |
| F4 | `PreToolUse` on `AskUserQuestion` answers it with `permissionDecision: "allow"` + `updatedInput` = the original input + `answers` (`{question text: answer}`); no dialog appears, in the panel or the terminal. A free-text answer reaches Claude as the user's instruction. Send a multi-select answer as one string joined with `", "`: 2.1.274 passes a list through as `Bun,Biome` (2.1.284 joins a list with `", "` itself). In 2.1.284 a call may carry a `title` above its 1–4 questions, and each question a `kind`: `choice` (the default: 2–4 `options`, `multiSelect`), `text` (`placeholder`) or `number` (`min` and `max`, and maybe `step`, `defaultValue`, `unit`), plus a `description` line. | hooks.md; S2; 2.1.283 and 2.1.284 binaries |
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
| F16 | Each stop leaves a `stop_hook_summary` line in the transcript (`transcript_path`) once the synchronous Stop hooks finish, chained by `parentUuid` after the stop's last assistant message. When Claude Code continues the turn, it first writes a continuation entry into that chain: a `hook_blocking_error` attachment (after a meta "Stop hook feedback" message) or a `hook_additional_context` attachment; `preventedContinuation: true` ends the turn anyway. `hookErrors` holds non-blocking errors and often a blocking hook's reason too, so it is not the signal. A stop's own assistant entry often reaches the file only after its Stop hooks have started (28 of 30 recorded stops). Seen in 2.1.274 and 2.1.283; undocumented. | 2.1.283 code; transcripts, 2026-09-28; recorded stops, 2026-09-29 (plan 2.8) |
| F17 | `ioreg -n Root -d 1`: the kernel's `IOConsoleLocked` is `Yes` while the screen is locked (also at the login window and on the way to sleep), and the console session in `IOConsoleUsers` then carries `CGSSessionScreenIsLocked`=Yes and `CGSSessionScreenLockedTime`. Unlocked, the flag is `No` and both keys are gone. This Mac locks itself after 30 minutes without input. | observed 2026-09-28 (plan 2.6) |
| F18 | A command hook runs as a direct child of the Claude Code process, with no shell in between, for synchronous and `asyncRewake` hooks alike, so a hook's parent pid is its Claude. | probed 2026-09-29 with 2.1.283 (plan 3.1) |
| F19 | A command hook's `statusMessage` is shown in the spinner while the hook runs. The `AskUserQuestion` dialog can resolve itself after a stretch of idle, telling Claude the user may be away (`afkTimeoutMs` in its result); `PostToolUse` follows as usual. | 2.1.284 binary (plan 4.1); the idle timeout not seen live |
| F20 | No hook can approve a plan (`ExitPlanMode`): after a hook's allow, Claude Code runs the tool's own permission check, and ExitPlanMode's always asks, so the plan dialog opens anyway. That holds for a `PreToolUse` allow (seen live) and a `PermissionRequest` allow, which the dialog ignores without `updatedInput` and re-asks with one. A deny from either stops the call; `AskUserQuestion`'s check is satisfied by the answers in `updatedInput`. The hook's input holds `plan` and `planFilePath` (seen live). | 2.1.284 binary; seen live 2026-09-29 (plan 4.2) |
| F21 | Claude Code writes a session's title into its transcript, and again every few turns: `{"type":"custom-title","customTitle":…}` for one you gave it, `{"type":"ai-title","aiTitle":…}` for the one it made; it shows `customTitle || aiTitle`. The made title can come a second after the first prompt, or only after the first turn; a hook sees it only when the session's next hook runs, often at the end of the turn. | 2.1.284 binary; transcripts, 2026-09-30 (plans 7.2, 7.5); undocumented |
| F22 | When Claude Code stops a hook (its `timeout`, likely a closed panel too), it kills the hook's whole process tree, found by parent pid (`ps -A -o pid= -o ppid=`), whatever session each process is in: a process the hook started that is still its child dies with it, even after `setsid`. One whose parent has exited, adopted by launchd, is outside the tree. | 2.1.283 live, 2026-09-30 08:25:12: the broker got SIGTERM 6 ms after a Stop hook reached its 12 h timeout; `killProcessTree` in the 2.1.284 binary (plan 7.6); undocumented |

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
| `PermissionRequest` | — | sync, timeout 12 h | While the dialog is open (F5): relay a Bash, Edit or Write prompt and return your decision (phase 5, D9); for any other tool, the "🔐 waiting for your permission" ping; skips `AskUserQuestion` and `ExitPlanMode`, relayed by `PreToolUse` |
| `StopFailure` | — | `async` | "⚠️ stopped on an API error" |
| `PreToolUse` | `AskUserQuestion\|ExitPlanMode` | sync, timeout 12 h | Ping (phase 2); relay a question and return the answers, or a plan and send it back for more planning (phase 4; F20) |
| `PostToolUse` | `AskUserQuestion\|ExitPlanMode` | `async` | Close a question or plan that was answered |
| `SessionEnd` | — | `async` | Mark the session ended, cancel its waiters |

Key flows:

1. **Turn finished → reply.** The Stop hook registers a waiter (a new generation for that session), then
   finds this stop's `stop_hook_summary` (F16): it reads the transcript's tail, so a summary written
   before the waiter started is found, skips a partial last line, takes the latest assistant entry whose
   text equals the input's `last_assistant_message` in the turn of its `prompt_id`, and follows
   `parentUuid` from it to the first summary. Until that entry is written, it reads again: an earlier
   turn's stop with the same text is never taken for it. The chain in between decides:
   - a continuation entry, without `preventedContinuation`: another hook, such as the Codex checkpoint,
     made Claude continue, so nothing is sent and the next stop decides;
   - anything else, including `hookErrors` from a hook that crashed: a real finish, so the
     "✅ `<session>`" + final message goes out if you are away, the session named by its title (F21) or,
     until it has one, by its folder, branch and the start of its id;
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
     you touch the keyboard or mouse (the spinner says so, F19).

   As built (plan 4.1): held or relayed, a question is the same in the chat, one message per question,
   answered with its buttons or a reply; the hook gets all the answers of a call together. Either way it
   goes to the local dialog at your first touch, unless `/away` is on (in between, presence looks every
   second while a question waits), or when you send `/local` or tap "🖥 Answer at the Mac". Muted,
   unpaired or ping-only (D8): the local dialog at once. No hook can answer a dialog that is already open
   locally, so if you leave while one is open, the bot only tells you a question is waiting at the
   computer. `/away` sent from your phone as you leave makes everything relay at once.

   A plan waiting for approval (`ExitPlanMode`, plan 4.2) goes the same way, as one question: the plan in
   the chat (a long one cut, with the 📄 file), and Keep planning or a reply with what to change, which
   denies the call with your words, so Claude keeps planning. No hook can approve a plan (F20): it is
   approved in its dialog at the Mac, which opens at your first touch or when you tap "🖥 Approve at the
   Mac".

   A permission prompt for Bash, Edit or Write (phase 5, D9) goes the same way too, but its dialog is
   open at the Mac all along: the `PermissionRequest` hook runs beside it (F5), so answering at the Mac
   works as ever. In the chat it shows the whole operation, never cut: the command, where it runs and
   every other field of its input, or the file and the full change, over up to four messages, or else as
   a file. Allow once or Deny; a reply denies it with your reason; never "always allow". A prompt with
   something that looks like a secret in it stays at the Mac, as it couldn't be shown whole, and so do
   ping-only folders. Claude Code drops a hook's answer once the dialog has one, so when the turn moves
   on, a prompt still in the chat was answered at the Mac: its message says so, and its hook stops.
   Every step, by the operation's ref (a hash), goes to the audit log.
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
  variables such as `BUN_CONFIG_VERBOSE_FETCH` can't log token-bearing URLs. No launchd plist. A hook
  starts it through a launcher that exits at once, so launchd adopts the broker and it is never in a
  hook's process tree, which Claude Code kills with the hook (F22, plan 7.6). A persistent "disabled"
  flag stops every hook, waiter and restart.
- **D4 Presence** as in flow 3: active < 30 s since your last input (F12); away after 3 min, when the
  screen is locked (F17), or on `/away`. An unreadable idle value counts as present, and `/status` shows
  it. Commands: `/away`, `/auto`, `/off` (mute), `/status`; `/local` hands questions back to the Mac (plan
  4.1), `/sessions` lists the open sessions and what each is doing (plan 7.3), and `/help` (also
  `/start`) is the guide. The paired chat alone gets them as its menu (`setMyCommands`), listed when "/"
  is typed and under the Menu button (plan 7.1). A session is open until its SessionEnd, which a crash
  never sends, so `/sessions` lists only those whose Claude process still runs: the broker keeps each
  session's, the parent pid its hooks bring (F18). Each is named by its title as it is when you ask,
  read from its transcript then, since a hook may not have run since Claude Code made it (F21, plan
  7.5). Under the list, a button for each session that can
  take a message (not one that stopped: no hook of it waits, so nothing would wake it). A tap sends a
  question with Telegram's reply box open on it (`force_reply`), linked to the session like a notice, so
  what you type goes to that session as in flow 4 (plan 7.4).
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
  Telegram. The chat shows Claude's Markdown as Telegram formatting (bold, italics, code, code blocks,
  tables as preformatted text with their columns lined up, web links), with file names and paths as code
  so that Telegram doesn't turn them into links (decided with you on 2026-09-29, at the phase 2
  checkpoint). Markup that Telegram refuses goes again as plain text. A session's title, which names it
  in messages (plan 7.2), counts as Claude's text: redacted, and not shown for ping-only folders.
- **D9 Permission prompts may be approved from Telegram** (O2, decided with you on 2026-09-29 after plan
  step 4.1): Allow once only, for Bash, Edit and Write; never for MCP tools or WebFetch; the complete
  operation shown; every decision in an audit log (phase 5).
- **D10 Git remote: GitHub** (O3, decided by you on 2026-09-30, after the plan): `origin` is your
  repository there. A push happens only when you ask, after the commits to push are scanned for secrets.

No questions are open.

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
- Remote approvals (D9) are Allow once only, bound to what you saw, and audited.
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
