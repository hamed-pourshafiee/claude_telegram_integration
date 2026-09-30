import type { BotCommand, InlineKeyboardMarkup } from "../shared/telegram/types.ts";
import type { Mode, Presence, Snapshot, State, Thresholds } from "./presence.ts";

/**
 * The bot's commands (D4): /local hands Claude's questions back to the Mac (plan 4.1), /help is the
 * guide (plan 7.1), and /sessions lists the open sessions (plan 7.3).
 */
export type CommandName = Mode | "status" | "local" | "help" | "sessions";
const NAMES: readonly CommandName[] = [
  "away",
  "auto",
  "off",
  "status",
  "local",
  "help",
  "sessions",
];
/** A command's answer with buttons under it, such as /sessions' (plan 7.4). */
export interface CommandAnswer {
  readonly text: string;
  readonly reply_markup?: InlineKeyboardMarkup;
}

/** Telegram sends /start when you first open the bot: it gets the guide. */
const ALIASES: ReadonlyMap<string, CommandName> = new Map([["start", "help"]]);

/**
 * The paired chat's menu (plan 7.1), in this order: Telegram lists it when "/" is typed and under the
 * chat's Menu button.
 */
export const MENU: readonly BotCommand[] = [
  { command: "status", description: "Where the bridge thinks you are, and why" },
  { command: "sessions", description: "Your open sessions, and which wait for you" },
  { command: "away", description: "Send everything here until /auto" },
  { command: "auto", description: "Decide from your idle time and the screen lock" },
  { command: "off", description: "Mute everything until /auto or /away" },
  { command: "local", description: "Hand the questions waiting here back to the Mac" },
  { command: "help", description: "What this bot does, and how to answer" },
];

/** The command in `text` ("/status", or "/status@SomeBot"), or undefined when it holds none. */
export function parseCommand(text: string): CommandName | undefined {
  const name = /^\/([A-Za-z]+)(?:@\w+)?$/.exec(text.trim())?.[1]?.toLowerCase();
  if (name === undefined) return undefined;
  return ALIASES.get(name) ?? NAMES.find((known) => known === name);
}

/** Carries out a command of the paired user about presence, or the guide; the answer for the chat. */
export function runCommand(name: Mode | "status" | "help", presence: Presence): string {
  if (name === "status") return statusText(presence.snapshot(), presence.limits);
  if (name === "help") return helpText(presence.limits);
  presence.setMode(name);
  switch (name) {
    case "away":
      return "🔴 Away mode: everything comes here from now on, even while you're at the Mac. Send /auto when you're back.";
    case "off":
      return "🔕 Off: nothing comes here until /auto or /away. /status still answers.";
    case "auto":
      return `${modeLine("auto", presence.limits)}\nNow: ${presenceLine(presence.snapshot())}`;
  }
}

/** The guide (/help, and /start): what comes here, how to answer it, and the commands. */
export function helpText(limits: Thresholds): string {
  return [
    "🤖 This bot brings your Claude Code sessions here while you're away from the Mac, and takes your answers back to them.",
    "",
    "What comes here:",
    "✅ Claude finished: reply, and it goes on",
    "❓ A question: tap an option, or reply with your own answer",
    "📋 A plan: reply with what to change; approve it at the Mac",
    "🔐 A permission: Allow once, Deny, or reply with your reason",
    "",
    "Reply to a message to answer its session. A plain message goes to the session that waits; with several, I ask which.",
    `You're away when the screen is locked or after ${duration(limits.awaySeconds)} without input. While you're at the Mac, nothing comes here unless you send /away.`,
    "",
    "Commands:",
    ...MENU.map(({ command, description }) => `/${command}: ${description}`),
  ].join("\n");
}

/** The answer to /status: where you are and why, the Mac's signals, and the mode. */
export function statusText(snapshot: Snapshot, limits: Thresholds): string {
  const idle = snapshot.idleSeconds === undefined ? "unknown" : duration(snapshot.idleSeconds);
  const screen =
    snapshot.locked === undefined ? "unknown" : snapshot.locked ? "locked" : "unlocked";
  return [
    presenceLine(snapshot),
    `Idle: ${idle} · Screen: ${screen}`,
    modeLine(snapshot.mode, limits),
  ].join("\n");
}

const LOOKS: Readonly<Record<State, string>> = {
  active: "🟢 At the Mac",
  between: "🟡 In between",
  away: "🔴 Away",
};

function presenceLine(snapshot: Snapshot): string {
  const idle = duration(snapshot.idleSeconds ?? 0);
  const why = {
    "away mode": "you sent /away",
    locked: "the screen is locked",
    idle: `no input for ${idle}`,
    input: `last input ${idle} ago`,
    unknown: "the idle time is unknown, which counts as at the Mac",
  }[snapshot.because];
  return `${LOOKS[snapshot.state]}: ${why}`;
}

function modeLine(mode: Mode, limits: Thresholds): string {
  switch (mode) {
    case "auto":
      return `Mode: auto. Away means the screen is locked or ${duration(limits.awaySeconds)} without input.`;
    case "away":
      return "Mode: away (/away). Everything comes here until /auto.";
    case "off":
      return "Mode: off (/off). Nothing comes here until /auto or /away.";
  }
}

/** "12 s", "3 min 5 s", "2 h 10 min". */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return whole % 60 === 0 ? `${minutes} min` : `${minutes} min ${whole % 60} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}
