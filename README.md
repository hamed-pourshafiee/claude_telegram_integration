# Claude Code ↔ Telegram bridge

When a Claude Code session on your Mac needs you while you're away from the computer, this bridge sends it
to a private chat with your own Telegram bot, and your answer goes back into the same session. It works
for the VS Code panel and for `claude` in a terminal, in any repo you choose to serve.

| When | Telegram shows | You can |
|---|---|---|
| Claude finishes a turn | ✅ and Claude's final message | Reply with text: the same session goes on |
| Claude asks a question | ❓ and the options as buttons | Tap an option, or reply with your own answer |
| Claude has a plan ready | 📋 and the plan | Reply with what to change, or tap Keep planning; approve it at the Mac |
| Claude wants to run a command or edit a file | 🔐 and the whole command or change | Allow once, Deny, or reply to deny with your reason |
| Claude stops on an API error | ⚠️ | — |

Nothing is sent while you're at the Mac, unless you ask for it with `/away`. The bridge consists of
hooks in `~/.claude/settings.json` and one small local process, the broker, that talks to Telegram. No
Remote Control, no cloud service in between, no open port.

## Requirements

- macOS (the bridge reads your idle time and screen lock from `ioreg`).
- [Bun](https://bun.sh) 1.4 or later.
- Claude Code: tested with the CLI 2.1.274 and the VS Code extension 2.1.283 and 2.1.284. Newer versions
  usually work; `bun run ctl doctor` tells you if the stops stop being read (see Troubleshooting).
- A Telegram account with **two-step verification on** (Settings → Privacy and Security). Whoever takes
  over your Telegram can drive Claude on this Mac through the bot.

## Setup

1. **Dependencies.** In this folder: `bun install`.
2. **A bot.** In Telegram, talk to [@BotFather](https://t.me/BotFather): `/newbot`, pick a name. It
   gives you a token.
3. **The token.** Copy the template and make it private, then put the token in yourself with an editor.
   Never paste the token into a chat, Claude's included.

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   The file then reads `TELEGRAM_BOT_TOKEN=<your token>`. It is gitignored.
4. **Which sessions** (optional). Without `config.json` only this repo's `sandbox/` folder is served.
   To serve more, `cp config.example.json config.json` and edit it:

   | Setting | Meaning | Default |
   |---|---|---|
   | `serve` | Sessions started inside these folders are served. Relative paths are from this repo; `~/` works. | `["sandbox"]` |
   | `skip` | …except those started inside these. | `[]` |
   | `entrypoints` | `claude-vscode` is the VS Code panel, `cli` the terminal. | both |
   | `presence` | Active under `activeSeconds` since your last input; away from `awaySeconds` on. | 30, 180 |
   | `content` | `default`: `full` or `ping-only`. Folders in `pingOnly` get pings without Claude's text, and their questions and permission prompts stay at the Mac. `maxChars`: a longer reply is cut, with a 📄 button for the whole text. | `full`, `[]`, 3500 |

   A session belongs to the folder it started in, even after a `cd`.
5. **Check.** `bun run ctl doctor`. Everything should pass except `hooks`, which you install in step 7.
6. **Pair.** `bun run ctl pair` prints a code; send `/pair <code>` to your bot within 10 minutes. From
   then on the bot listens to you alone, in your private chat with it.
7. **Install the hooks.** `bun run ctl install --dry-run` shows the entries it adds to
   `~/.claude/settings.json`; `bun run ctl install` adds them, after a backup to `.state/backups/`. They
   apply to every Claude Code session on this Mac from then on; sessions outside the served folders
   are left alone. Running it again replaces our entries and leaves yours as they are.
8. **Try it.** Send `/away` to the bot, then give Claude a small task in a served folder. The ✅ arrives
   with Claude's answer; reply to it and Claude carries on. Send `/auto` when you're done.

## Day to day

**Where you are.** The bridge decides from your keyboard and mouse and the screen lock:

- **Active** (input in the last 30 s): nothing goes to Telegram; questions and prompts open at the Mac.
- **Away** (no input for 3 min, the screen locked, or `/away`): everything goes to Telegram.
- **In between**: finished turns aren't sent. A question, plan or permission prompt goes to Telegram,
  and moves to its dialog at the Mac the moment you touch the keyboard or mouse; the spinner says so.

Your Mac has to stay awake while you're away: the display may sleep, the system not. With the lid
closed, a MacBook sleeps unless it's on power with an external display.

**Which session.** Each message names its session by the title Claude Code shows for it, such as
"✅ Fix the login bug". A new session goes by its folder until Claude Code has given it a title, often
after its first turn. Ping-only folders always go by the folder.

**Answering.** Reply to a bot message and your answer goes to that message's session. A plain message
goes to the only session waiting for you; with several waiting, the bot asks which one. A question's
buttons answer it; so does a reply to it. If you type at the Mac while a reply is on its way, the first
one wins: a reply that comes after your typing isn't used, and if it went in just before, the bot tells
you it crossed.

**Permission prompts** (Bash, Edit and Write only). The message shows the whole command and where it
runs, or the file and the full change, split over several messages or sent as a file if long. Allow
once allows this one call; there is no "always allow" from Telegram. Deny, or reply with your reason,
and Claude hears why. The dialog stays open at the Mac all along, so you can also answer there. A
prompt for any other tool, or one that seems to contain a secret, stays at the Mac: while you're away,
the bot only tells you it's waiting there.
Every decision goes to `.state/logs/audit.log`, by a short hash of the operation, never its text.

**Plans.** Claude's plan comes to the chat; reply with what to change (or tap Keep planning) and Claude
plans again. A plan can only be approved at the Mac: tap "🖥 Approve at the Mac", then approve it there.

**Commands** in the bot chat: type `/` or tap the chat's Menu button to see them, each with a line on
what it does.

| Command | Does |
|---|---|
| `/status` | Where the bridge thinks you are, and why |
| `/away` | Relay everything until `/auto`, even while you're at the Mac |
| `/auto` | Decide from your idle time and the screen lock again |
| `/off` | Mute everything until `/auto` or `/away` |
| `/local` | Hand the questions waiting in the chat back to the dialogs at the Mac |
| `/help` | A short guide: what comes to the chat, how to answer it, and these commands |

## Commands on the Mac

All run from this folder:

| Command | Does |
|---|---|
| `bun run ctl doctor` | Checks config.json, .env, the bot (never shows the token), the broker, the privacy of `.state/`, the hooks and the Bun they run, and whether Claude's stops are being read |
| `bun run ctl status` | Is the broker running, with this repo's token? Paired? Where are you? |
| `bun run ctl start` / `stop` | Starts or stops the broker; a hook starts it when needed anyway |
| `bun run ctl pair` | A new pairing code (10 minutes) |
| `bun run ctl install` / `uninstall` | Adds or removes our hooks; `--dry-run` shows what would change |
| `bun run ctl disable` / `enable` | Turns the whole bridge off (hooks do nothing, the broker stops) and on again |

## Uninstall

`bun run ctl uninstall` runs in this order:

1. It sets the disabled flag: hooks do nothing from then on, any hook still waiting (for a reply, a
   question's answers, a permission) leaves without a decision, and nothing starts the broker again.
   Questions and prompts that were waiting open at the Mac as usual.
2. It removes only our entries from `~/.claude/settings.json`, after a backup; anything you changed
   since install stays.
3. It stops the broker.

Then you can delete this folder: nothing else is left on the Mac. The settings backups are in
`.state/backups/`, so copy one out first if you want to keep it. To pause instead, `/off` in the chat
mutes everything, and `bun run ctl disable` turns the bridge off until `enable`.

## Security

- Only your paired Telegram account, in a private chat, can do anything; everything else is dropped.
- The token lives only in `.env` (0600) and never appears in logs or output. The broker listens on a
  Unix socket (0600) inside `.state/` (0700): no network port.
- Hooks run with `--no-env-file` and this repo's `bunfig.toml`, and the broker with a minimal
  environment, so another project's `.env` or settings never reach them.
- Claude's text is redacted for things that look like secrets before it's sent, and long text is cut.
  The logs hold ids, sizes and timings, not message text.
- A reply from Telegram reaches Claude marked "📨 Telegram reply from …", so it knows where it came from.

## Troubleshooting

Start with `bun run ctl doctor` and `bun run ctl status`, or send `/status` to the bot. The logs are in
`.state/logs/`: `broker.log`, `hooks.log`, `ctl.log` and `audit.log`. Past 5 MB a log is rotated to
`.1`, and three copies are kept.

- **No ✅ after a turn.** Were you away (`/status`)? Did the session start inside a served folder, and is
  its kind in `entrypoints` (`ctl doctor` lists both)?
- **`stops` fails in `ctl doctor`.** The bridge tells a finished turn from one that goes on by an
  undocumented line in Claude Code's transcript (F16 in the design). If a Claude Code update changed it,
  no ✅ is sent for those stops, and the design needs a look.
- **`hooks` fails.** They are missing, or were installed by another version of the bridge: see
  `bun run ctl install --dry-run`, then install again.
- **The broker runs with another token** (`ctl status`): you changed `.env`; `bun run ctl stop`, and
  the next hook starts it with the new one.

## How it's built

[project-docs/design.md](project-docs/design.md) is the design: the platform facts it relies on, the
flows, the decisions and the risks. [project-docs/implementation-plan.md](project-docs/implementation-plan.md)
is the order of work, and [project-docs/progress.md](project-docs/progress.md) records each step with its
evidence. `bun run typecheck`, `bun run lint` and `bun test` are the gate for every change.
