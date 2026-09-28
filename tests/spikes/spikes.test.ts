import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asObject,
  isInside,
  type JsonObject,
  REPO_ROOT,
  SANDBOX_DIR,
  SPIKE_DIR,
} from "../../scripts/spikes/lib.ts";
import { spikeEntries, withGroup, withoutSpikes } from "../../scripts/spikes/settings.ts";

describe("isInside", () => {
  test.each([
    [SANDBOX_DIR, true],
    [join(SANDBOX_DIR, "a", "b"), true],
    [join(SANDBOX_DIR, "..named-like-parent"), true],
    [REPO_ROOT, false],
    [`${SANDBOX_DIR}-other`, false],
    ["/tmp", false],
  ])("%s → %p", (path, expected) => {
    expect(isInside(path, SANDBOX_DIR)).toBe(expected);
  });
});

describe("s1 hook in a session outside sandbox/", () => {
  const otherRepo = mkdtempSync(join(tmpdir(), "s1-other-repo-"));
  const marker = join(otherRepo, "preload-ran");
  const log = join(SPIKE_DIR, "s1.log");
  writeFileSync(
    join(otherRepo, "preload.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
  );
  writeFileSync(join(otherRepo, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  beforeEach(() => rmSync(marker, { force: true }));
  afterAll(() => rmSync(otherRepo, { recursive: true, force: true }));

  async function runHook(flags: string[]): Promise<{ code: number; stderr: string; ms: number }> {
    const started = performance.now();
    const input = { session_id: "test", cwd: otherRepo, hook_event_name: "Stop" };
    const hook = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        ...flags,
        join(REPO_ROOT, "scripts/spikes/s1-stop-rewake.ts"),
      ],
      { cwd: otherRepo, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([hook.exited, new Response(hook.stderr).text()]);
    return { code, stderr, ms: performance.now() - started };
  }

  test("exits 0 at once, writes nothing and runs none of that repo's bunfig preload", async () => {
    const logSize = existsSync(log) ? statSync(log).size : -1;
    const result = await runHook([`--config=${REPO_ROOT}/bunfig.toml`]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.ms).toBeLessThan(5000);
    expect(existsSync(log) ? statSync(log).size : -1).toBe(logSize);
    expect(existsSync(marker)).toBe(false);
  });

  test("control: without --config, Bun does run that repo's preload", async () => {
    await runHook([]);
    expect(existsSync(marker)).toBe(true);
  });
});

const entries = spikeEntries("/opt/bun", "/repo");
const s1 = entries.s1?.[0];
if (!s1) throw new Error("no s1 entry");

describe("spike settings entries", () => {
  test("s1 is an asyncRewake Stop hook that pins Bun's env file and config", () => {
    expect(s1.event).toBe("Stop");
    expect(s1.group).toEqual({
      hooks: [
        {
          type: "command",
          command:
            "/opt/bun --no-env-file --config=/repo/bunfig.toml /repo/scripts/spikes/s1-stop-rewake.ts",
          timeout: 900,
          asyncRewake: true,
        },
      ],
    });
  });

  test("s2 is a synchronous PreToolUse hook matched to AskUserQuestion", () => {
    expect(entries.s2).toEqual([
      {
        event: "PreToolUse",
        group: {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command:
                "/opt/bun --no-env-file --config=/repo/bunfig.toml /repo/scripts/spikes/s2-answer-question.ts",
              timeout: 30,
            },
          ],
        },
      },
    ]);
  });

  test("refuses paths that would need shell quoting", () => {
    expect(() => spikeEntries("/Applications/My Bun/bun", "/repo")).toThrow("shell quoting");
  });
});

test("s3 records all nine events; only UserPromptSubmit and SessionEnd are synchronous", () => {
  const recorded = (entries.s3 ?? []).map((entry) => {
    const hooks = entry.group.hooks;
    const hook = Array.isArray(hooks) ? asObject(hooks[0]) : undefined;
    expect(hook?.command).toBe(
      "/opt/bun --no-env-file --config=/repo/bunfig.toml /repo/scripts/spikes/s3-record.ts",
    );
    return [entry.event, entry.group.matcher ?? "", hook?.async ? "async" : "sync", hook?.timeout];
  });
  expect(recorded).toEqual([
    ["SessionStart", "", "async", 10],
    ["UserPromptSubmit", "", "sync", 10],
    ["Stop", "", "async", 10],
    ["Notification", "", "async", 10],
    ["StopFailure", "", "async", 10],
    ["PreToolUse", "AskUserQuestion", "async", 10],
    ["PostToolUse", "AskUserQuestion", "async", 10],
    ["PermissionRequest", "", "async", 10],
    ["SessionEnd", "", "sync", 5],
  ]);
});

describe("adding and removing spike entries", () => {
  const spikes = "/repo/scripts/spikes";
  const codex = { hooks: [{ type: "command", command: "/x/codex-checkpoint-code.sh" }] };
  const original: JsonObject = {
    theme: "dark",
    hooks: { Stop: [codex] },
    autoCompactEnabled: true,
  };
  const stopGroups = (settings: JsonObject): unknown => asObject(settings.hooks)?.Stop;

  test("adding appends after the existing Stop groups, once", () => {
    const once = withGroup(original, s1.event, s1.group);
    expect(stopGroups(once)).toEqual([codex, s1.group]);
    expect(JSON.stringify(withGroup(once, s1.event, s1.group))).toBe(JSON.stringify(once));
  });

  test("removing restores the original bytes and keeps edits made since", () => {
    const added = withGroup(original, s1.event, s1.group);
    expect(JSON.stringify(withoutSpikes(added, spikes))).toBe(JSON.stringify(original));
    const mine = { hooks: [{ type: "command", command: "/x/added-later.sh" }] };
    expect(stopGroups(withoutSpikes(withGroup(added, "Stop", mine), spikes))).toEqual([
      codex,
      mine,
    ]);
  });

  test("a hook added later into the spike's own group survives removal", () => {
    const later = { type: "command", command: "/x/added-into-our-group.sh" };
    const spikeHooks = s1.group.hooks;
    if (!Array.isArray(spikeHooks)) throw new Error("s1 group has no hooks array");
    const shared = withGroup(original, "Stop", { hooks: [...spikeHooks, later] });
    expect(stopGroups(withoutSpikes(shared, spikes))).toEqual([codex, { hooks: [later] }]);
  });

  test("an event that only the spike used is dropped again", () => {
    const noStop: JsonObject = { hooks: { SessionStart: [codex] } };
    const roundTrip = withoutSpikes(withGroup(noStop, s1.event, s1.group), spikes);
    expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(noStop));
  });
});
