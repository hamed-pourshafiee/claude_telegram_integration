import { describe, expect, test } from "bun:test";
import {
  needsFile,
  operationBody,
  operationFile,
  operationTitle,
  type Permission,
  parsePermission,
} from "../../src/broker/operation.ts";

// Phase 5 (D9): a permission prompt's operation, shown whole: the command and where it runs, or the
// file and the full change, and every other field of the input.
function parsed(value: unknown): Permission {
  const permission = parsePermission(value);
  if (permission === undefined) throw new Error("not parsed");
  return permission;
}

const bash = (input: Record<string, unknown>) =>
  parsed({ tool: "Bash", input: { command: "npm test", ...input }, cwd: "/work/app" });

describe("which prompts can be relayed (D9)", () => {
  test("Bash, Edit and Write, with the parts that make them up", () => {
    expect(bash({}).tool).toBe("Bash");
    const edit = { file_path: "/a.ts", old_string: "a", new_string: "b" };
    expect(parsed({ tool: "Edit", input: edit, cwd: "/w" }).tool).toBe("Edit");
    expect(
      parsed({ tool: "Write", input: { file_path: "/a.ts", content: "" }, cwd: "/w" }).tool,
    ).toBe("Write");
  });

  test("never MCP tools, WebFetch or anything else; nor an input without its parts", () => {
    const refused = [
      { tool: "mcp__GitLab__glab_mr_merge", input: { id: 1 }, cwd: "/w" },
      { tool: "WebFetch", input: { url: "https://example.com" }, cwd: "/w" },
      { tool: "NotebookEdit", input: { notebook_path: "/a.ipynb" }, cwd: "/w" },
      { tool: "Bash", input: { description: "no command" }, cwd: "/w" },
      { tool: "Edit", input: { file_path: "/a.ts", old_string: "a" }, cwd: "/w" },
      { tool: "Bash", input: { command: "ls" } },
    ];
    for (const value of refused) expect(parsePermission(value)).toBeUndefined();
  });
});

describe("the operation, whole", () => {
  test("a command: where it runs, all of it, what it's for, and its ref", () => {
    const permission = bash({ description: "Run the tests" });
    expect(operationTitle(permission)).toBe("wants to run a command");
    expect(operationBody(permission)).toBe(
      `In \`/work/app\`:\n\`\`\`sh\nnpm test\n\`\`\`\n_Run the tests_\nref ${permission.hash}`,
    );
  });

  test("every other field is shown, so a flag like dangerouslyDisableSandbox can't hide", () => {
    const body = operationBody(bash({ dangerouslyDisableSandbox: true, timeout: 600000 }));
    expect(body).toContain("dangerouslyDisableSandbox: `true`");
    expect(body).toContain("timeout: `600000`");
  });

  test("an edit: the file, what is replaced and with what, every occurrence when so", () => {
    const input = {
      file_path: "/w/a.ts",
      old_string: "a < b",
      new_string: "a <= b",
      replace_all: true,
    };
    const permission = parsed({ tool: "Edit", input, cwd: "/w" });
    expect(operationTitle(permission)).toBe("wants to edit /w/a.ts");
    expect(operationBody(permission)).toBe(
      `Replace (every occurrence):\n\`\`\`\na < b\n\`\`\`\nWith:\n\`\`\`\na <= b\n\`\`\`\nref ${permission.hash}`,
    );
  });

  test("the ref changes with the operation", () => {
    expect(bash({}).hash).toMatch(/^[0-9a-f]{8}$/);
    expect(bash({}).hash).not.toBe(bash({ command: "npm test -- --watch" }).hash);
  });

  test("a line that would end its code block early: the operation goes as a file", () => {
    expect(needsFile(bash({}))).toBe(false);
    const readme = { file_path: "/w/README.md", content: "# App\n\n```sh\nbun test\n```\n" };
    const write = parsed({ tool: "Write", input: readme, cwd: "/w" });
    expect(needsFile(write)).toBe(true);
    expect(operationFile(write)).toBe(
      `Write, in /w\n\n--- file_path ---\n/w/README.md\n\n--- content ---\n${readme.content}\n\nref ${write.hash}`,
    );
  });
});
