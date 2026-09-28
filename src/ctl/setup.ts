import { messageOf } from "../shared/errors.ts";
import type { Log } from "../shared/log.ts";
import type { Outcome } from "./broker.ts";
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

/**
 * `ctl install [--dry-run]` (plan 2.7): adds our hooks to settings.json, replacing ours from before, so
 * running it twice leaves one set. It backs the file up first and writes it in one rename. A dry run
 * prints exactly what would be added and changes nothing.
 */
export function installHooks(paths: InstallPaths, dryRun: boolean, log: Log): Outcome {
  return attempt(() => {
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
}

/** `ctl uninstall [--dry-run]`: removes only our hooks; everything else stays as it is now. */
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
