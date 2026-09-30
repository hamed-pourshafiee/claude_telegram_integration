import { type BrokerLaunch, brokerHealth } from "../shared/broker-client.ts";
import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { StatePaths } from "../shared/paths.ts";
import { setDisabled } from "../shared/state.ts";
import { type Outcome, stopBroker } from "./broker.ts";
import {
  backup,
  countOurs,
  hookGroups,
  type InstallPaths,
  readSettings,
  serialize,
  withOurs,
  withoutOurs,
  writeAtomically,
} from "./install.ts";

/** What uninstall touches: the settings file, and the bridge's state and broker. */
export interface BridgePaths {
  readonly hooks: InstallPaths;
  readonly state: StatePaths;
  readonly launch: BrokerLaunch;
}

const DISABLED_NOTE =
  "the bridge is disabled (by uninstall or 'ctl disable'): 'bun run ctl enable' turns it on";

/**
 * `ctl install [--dry-run]` (plan 2.7): adds our hooks to settings.json, replacing ours from before, so
 * running it twice leaves one set. It backs the file up first and writes it in one rename. A dry run
 * prints exactly what would be added and changes nothing. While the bridge is disabled, it says so.
 */
export function installHooks(
  paths: InstallPaths,
  dryRun: boolean,
  log: Log,
  disabled = false,
): Outcome {
  const outcome = attempt(() => {
    const { text, settings } = readSettings(paths.settingsFile);
    const groups = hookGroups(paths.bun, paths.repoRoot);
    const ours = countOurs(settings, paths.repoRoot);
    if (dryRun) return { ok: true, text: installPlan(paths.settingsFile, groups, ours) };
    const next = serialize(withOurs(settings, groups, paths.repoRoot));
    if (next === text)
      return { ok: true, text: `already installed (${ours} hooks); nothing changed` };
    const saved = backup(paths.settingsFile, paths.backupDir);
    writeAtomically(paths.settingsFile, next, text);
    const installed = Object.keys(groups).length;
    log("hooks.installed", { hooks: installed, replaced: ours });
    return {
      ok: true,
      text: `installed ${installed} hooks into ${paths.settingsFile}${saved ? `\nbackup: ${saved}` : ""}`,
    };
  });
  return outcome.ok && disabled ? { ok: true, text: `${outcome.text}\n${DISABLED_NOTE}` } : outcome;
}

/** Removes only our hooks from settings.json; everything else stays as it is now. */
export function uninstallHooks(paths: InstallPaths, dryRun: boolean, log: Log): Outcome {
  return attempt(() => {
    const { text, settings } = readSettings(paths.settingsFile);
    const ours = countOurs(settings, paths.repoRoot);
    if (ours === 0) return { ok: true, text: "not installed; nothing to remove" };
    if (dryRun) {
      return { ok: true, text: `would remove ${ours} hooks from ${paths.settingsFile}, only ours` };
    }
    const saved = backup(paths.settingsFile, paths.backupDir);
    writeAtomically(paths.settingsFile, serialize(withoutOurs(settings, paths.repoRoot)), text);
    log("hooks.uninstalled", { hooks: ours });
    return {
      ok: true,
      text: `removed ${ours} hooks from ${paths.settingsFile}\nbackup: ${saved ?? "none"}`,
    };
  });
}

/**
 * `ctl uninstall [--dry-run]`, in the order of design §6. The disabled flag comes first: new hooks exit
 * at once, waiting ones leave with no decision, and nothing starts the broker again. Then only our hooks
 * go from settings.json, keeping any edit made since install. Last, the broker stops.
 */
export async function uninstallBridge(
  paths: BridgePaths,
  dryRun: boolean,
  log: Log,
): Promise<Outcome> {
  const running = (await brokerHealth(paths.state, log))?.pid;
  if (dryRun) {
    const hooks = uninstallHooks(paths.hooks, true, log);
    const broker =
      running === undefined ? "no broker runs" : `would stop the broker (pid ${running})`;
    return { ok: hooks.ok, text: ["would set the disabled flag", hooks.text, broker].join("\n") };
  }
  setDisabled(paths.state, true);
  log("bridge.disabled", { by: "uninstall" });
  const hooks = uninstallHooks(paths.hooks, false, log);
  const broker = await stopBroker(paths.state, paths.launch, log, running);
  const lines = [
    "disabled: hooks do nothing now, and nothing starts the broker",
    hooks.ok ? hooks.text : `hooks not removed: ${hooks.text}; run 'bun run ctl uninstall' again`,
    `the broker: ${broker.text}`,
  ];
  return { ok: hooks.ok && broker.ok, text: lines.join("\n") };
}

function installPlan(
  file: string,
  groups: Readonly<Record<string, unknown[]>>,
  ours: number,
): string {
  const lines = [
    `Would add these hook groups to ${file}, after a backup to .state/backups/`,
    ours > 0
      ? `(replacing the ${ours} hooks of ours already there):`
      : "(none of ours is there yet):",
  ];
  for (const [event, list] of Object.entries(groups)) {
    for (const group of list) lines.push(`${event}: ${JSON.stringify(group, null, 2)}`);
  }
  return lines.join("\n");
}

function attempt(work: () => Outcome): Outcome {
  try {
    return work();
  } catch (error) {
    return { ok: false, text: messageOf(error) };
  }
}
