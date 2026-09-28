import { messageOf } from "../shared/errors.ts";

// What macOS says about the person at the keyboard (D4), read with ioreg: the time since the last
// keyboard or mouse input (F12), and whether the screen is locked.

/** By absolute path: the broker's PATH is minimal (D3). */
const IOREG = "/usr/sbin/ioreg";
/** The IOHIDSystem object alone; its HIDIdleTime is the time since the last input, in nanoseconds. */
export const IDLE_QUERY: readonly string[] = ["-r", "-c", "IOHIDSystem", "-d", "1"];
/** The registry's root: IOConsoleLocked, and the login sessions in IOConsoleUsers. */
export const LOCK_QUERY: readonly string[] = ["-n", "Root", "-d", "1"];

/** One look at the Mac. A value ioreg didn't give is undefined, and `problems` says why. */
export interface Reading {
  /** Seconds since the last keyboard or mouse input, to the millisecond. */
  readonly idleSeconds: number | undefined;
  readonly locked: boolean | undefined;
  readonly problems: readonly string[];
}

/** Before the first look, and whenever ioreg can't be read: nothing known. */
export const UNKNOWN: Reading = { idleSeconds: undefined, locked: undefined, problems: [] };

/**
 * Seconds since the last keyboard or mouse input, from HIDIdleTime in nanoseconds (F12). With several
 * IOHIDSystem objects the smallest wins, which errs toward "at the Mac"; with none, undefined.
 */
export function parseIdleSeconds(output: string): number | undefined {
  const values = [...output.matchAll(/^\s*"HIDIdleTime" = (\d{1,30})\s*$/gm)].map((match) =>
    BigInt(match[1] ?? "0"),
  );
  if (values.length === 0) return undefined;
  const least = values.reduce((smallest, value) => (value < smallest ? value : smallest));
  return Number(least / 1_000_000n) / 1000;
}

const SESSION_LOCKED = '"CGSSessionScreenIsLocked"=Yes';
const ON_CONSOLE = '"kCGSSessionOnConsoleKey"=Yes';

/**
 * Whether the screen is locked. The kernel sets IOConsoleLocked once a lock takes effect, and also at
 * the login window and on the way to sleep; the session on the console carries
 * CGSSessionScreenIsLocked while it is locked. Undefined when the output has neither.
 */
export function parseScreenLocked(output: string): boolean | undefined {
  const flag = /^\s*"IOConsoleLocked" = (Yes|No)\s*$/m.exec(output)?.[1];
  const users = /^\s*"IOConsoleUsers" = \((.*)\)\s*$/m.exec(output)?.[1];
  const onConsole = users?.match(/\{[^{}]*\}/g)?.find((session) => session.includes(ON_CONSOLE));
  if (flag === "Yes" || onConsole?.includes(SESSION_LOCKED)) return true;
  if (flag === "No" || onConsole !== undefined) return false;
  return undefined;
}

export interface ReadOptions {
  /** Tests use a stand-in. */
  readonly ioreg?: string;
  /** A slower ioreg is killed and its value counts as unknown; default 2 s. */
  readonly timeoutMs?: number;
}

/** Reads the idle time and the screen lock, both at once; never throws. */
export async function readPresence(options: ReadOptions = {}): Promise<Reading> {
  const run = (args: readonly string[]) =>
    ioreg(options.ioreg ?? IOREG, args, options.timeoutMs ?? 2000);
  const [idle, lock] = await Promise.all([run(IDLE_QUERY), run(LOCK_QUERY)]);
  const problems: string[] = [];
  const idleSeconds = interpret(idle, parseIdleSeconds, "idle time", problems);
  const locked = interpret(lock, parseScreenLocked, "screen lock", problems);
  return { idleSeconds, locked, problems };
}

type Output = { readonly text: string } | { readonly problem: string };

function interpret<T>(
  output: Output,
  parse: (text: string) => T | undefined,
  what: string,
  problems: string[],
): T | undefined {
  if ("problem" in output) {
    problems.push(`${what}: ${output.problem}`);
    return undefined;
  }
  const value = parse(output.text);
  if (value === undefined) problems.push(`${what}: not in ioreg's output`);
  return value;
}

async function ioreg(path: string, args: readonly string[], timeoutMs: number): Promise<Output> {
  try {
    const child = Bun.spawn({
      cmd: [path, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (child.signalCode !== null) {
      return { problem: `ioreg was stopped by ${child.signalCode} (limit ${timeoutMs} ms)` };
    }
    return code === 0 ? { text } : { problem: `ioreg exited with ${code}` };
  } catch (error) {
    return { problem: `ioreg didn't run: ${messageOf(error)}` };
  }
}
