import { type BrokerLaunch, callBroker, ensureBroker } from "../shared/broker-client.ts";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { clock, type Outcome } from "./broker.ts";

/**
 * `ctl pair` (plan 2.4): starts the broker if needed, asks it for a one-time pairing code and says
 * what to send the bot. The code is shown only here, in your terminal.
 */
export async function pairBot(paths: StatePaths, launch: BrokerLaunch, log: Log): Promise<Outcome> {
  const state = await ensureBroker(paths, launch, log);
  if (state === "disabled") return { ok: false, text: "disabled: run 'bun run ctl enable' first" };
  if (state === "failed") {
    return { ok: false, text: "the broker didn't start; see .state/logs/broker.log" };
  }
  const answer = asFields(await callBroker(paths, "/pair", {}, log));
  const code = answer?.code;
  const expiresAt = answer?.expiresAt;
  if (typeof code !== "string" || typeof expiresAt !== "string") {
    return { ok: false, text: "the broker gave no pairing code; see .state/logs/broker.log" };
  }
  return { ok: true, text: pairingInstructions(code, expiresAt) };
}

export function pairingInstructions(code: string, expiresAt: string): string {
  return [
    `Pairing code: ${code}   (one use, valid until ${clock(expiresAt)})`,
    "",
    "In Telegram, open the chat with your bot and send:",
    "",
    `    /pair ${code}`,
    "",
    'The bot answers "Paired ✅". From then on it listens only to you, in that private chat.',
  ].join("\n");
}
