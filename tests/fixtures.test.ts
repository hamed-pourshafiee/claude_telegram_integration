import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Real hook inputs recorded in step 1.4 (spike S3): <entrypoint>/<Event>[-<detail>].json, each holding
// { recordedAt, entrypoint, projectDir?, input }. Phase 2 tests feed `input` to the hooks as stdin.
const root = join(dirname(import.meta.dir), "tests", "fixtures", "hooks");
const files = readdirSync(root).flatMap((entrypoint) =>
  readdirSync(join(root, entrypoint)).map((name) => join(root, entrypoint, name)),
);
const fixtures = files.map((file) => ({
  file,
  text: readFileSync(file, "utf8"),
  data: JSON.parse(readFileSync(file, "utf8")) as {
    entrypoint: string;
    projectDir?: string | null;
    input: Record<string, unknown>;
  },
}));

describe("recorded hook fixtures", () => {
  test.each(fixtures.map((f) => [basename(dirname(f.file)), basename(f.file), f] as const))(
    "%s/%s matches its name and holds no home path or secret",
    (entrypoint, name, fixture) => {
      expect(fixture.data.entrypoint).toBe(entrypoint);
      expect(name.startsWith(`${String(fixture.data.input.hook_event_name)}`)).toBe(true);
      expect(fixture.text).not.toContain("/Users/");
      expect(fixture.text).not.toMatch(
        /(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9]{16}/,
      );
    },
  );

  test("cover every event of design §3's hook table", () => {
    const seen = new Set(
      fixtures.map(({ data: { input } }) =>
        [input.hook_event_name, input.notification_type ?? input.tool_name ?? ""].join(":"),
      ),
    );
    for (const needed of [
      "SessionStart:",
      "UserPromptSubmit:",
      "Stop:",
      "Notification:idle_prompt",
      "Notification:permission_prompt",
      "StopFailure:",
      "PreToolUse:AskUserQuestion",
      "PostToolUse:AskUserQuestion",
      "PermissionRequest:Bash",
      "SessionEnd:",
    ]) {
      expect(seen).toContain(needed);
    }
  });

  test("a session that cd'd into sandbox/ keeps its start dir in CLAUDE_PROJECT_DIR", () => {
    const cd = fixtures.find((f) => f.file.endsWith("sdk-cli/Stop-after-cd.json"));
    expect(cd?.data.input.cwd).toBe("~/src/bc/claude_telegram_integration/sandbox");
    expect(cd?.data.projectDir).toBe("~/src/bc/claude_telegram_integration");
  });
});
