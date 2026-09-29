import type { Mode, Presence, Snapshot, State, Thresholds } from "./presence.ts";

/** The bot's commands (D4), and /local, which hands Claude's questions back to the Mac (plan 4.1). */
export type CommandName = Mode | "status" | "local";
const NAMES: readonly CommandName[] = ["away", "auto", "off", "status", "local"];

/** The command in `text` ("/status", or "/status@SomeBot"), or undefined when it holds none. */
export function parseCommand(text: string): CommandName | undefined {
  const name = /^\/([A-Za-z]+)(?:@\w+)?$/.exec(text.trim())?.[1]?.toLowerCase();
  return NAMES.find((known) => known === name);
}

/** Carries out a presence command of the paired user and returns the answer for the chat. */
export function runCommand(name: Mode | "status", presence: Presence): string {
  if (name === "status") return statusText(presence.snapshot(), presence.limits);
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
