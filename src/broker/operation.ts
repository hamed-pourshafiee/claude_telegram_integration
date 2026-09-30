import { createHash } from "node:crypto";
import { asFields, type Fields } from "../shared/json.ts";
import { POLICY_TOOLS } from "../shared/permission.ts";

/** A permission prompt's operation (phase 5, D9): the tool, its input as Claude Code gave it, where. */
export interface Permission {
  readonly tool: string;
  readonly input: Fields;
  readonly cwd: string;
  /** Of the tool and its input, shown with it: the audit log is bound to it (D9). */
  readonly hash: string;
}

/** The input fields each tool's view shows by name; any other field is listed as well. */
const SHOWN: Readonly<Record<string, readonly string[]>> = {
  Bash: ["command", "description"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Write: ["file_path", "content"],
};

/** A relayed prompt's operation, or undefined for a tool outside the policy or an input without its parts. */
export function parsePermission(value: unknown): Permission | undefined {
  const fields = asFields(value);
  const tool = fields?.tool;
  const input = asFields(fields?.input);
  const cwd = fields?.cwd;
  if (typeof tool !== "string" || !POLICY_TOOLS.includes(tool)) return undefined;
  if (input === undefined || typeof cwd !== "string") return undefined;
  const needed =
    tool === "Bash"
      ? ["command"]
      : tool === "Write"
        ? ["file_path", "content"]
        : ["file_path", "old_string", "new_string"];
  if (!needed.every((name) => typeof input[name] === "string")) return undefined;
  return { tool, input, cwd, hash: operationHash(tool, input) };
}

export function operationHash(tool: string, input: Fields): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, input]))
    .digest("hex")
    .slice(0, 8);
}

/** The prompt's header after the session's label: what Claude wants to do. */
export function operationTitle(permission: Permission): string {
  const path = text(permission.input.file_path);
  if (permission.tool === "Bash") return "wants to run a command";
  return `wants to ${permission.tool === "Edit" ? "edit" : "write"} ${path}`;
}

/**
 * The whole operation as Markdown, never shortened (D9): the command and where it runs, or the file and
 * the full change, then every other field of the input, so nothing that matters is left out.
 */
export function operationBody(permission: Permission): string {
  const { tool, input, cwd } = permission;
  const lines: string[] = [];
  if (tool === "Bash") {
    lines.push(`In \`${cwd}\`:`, ...block(text(input.command), "sh"));
    if (text(input.description)) lines.push(`_${text(input.description)}_`);
  } else if (tool === "Edit") {
    // The path in full here too: a header is cut at 200 characters.
    const every = input.replace_all === true ? " (every occurrence)" : "";
    lines.push(
      `In \`${text(input.file_path)}\`, replace${every}:`,
      ...block(text(input.old_string)),
      "With:",
      ...block(text(input.new_string)),
    );
  } else {
    lines.push(`New content of \`${text(input.file_path)}\`:`, ...block(text(input.content)));
  }
  const rest = Object.entries(input).filter(([name]) => !(SHOWN[tool] ?? []).includes(name));
  for (const [name, value] of rest) lines.push(`${name}: \`${JSON.stringify(value)}\``);
  lines.push(`ref ${permission.hash}`);
  return lines.join("\n");
}

/**
 * Whether the operation can't be shown safely as Markdown: a line that would end its code block, or a
 * path with a backtick, which would end its code span.
 */
export function needsFile(permission: Permission): boolean {
  const { input, cwd } = permission;
  if ([cwd, text(input.file_path)].some((path) => path.includes("`"))) return true;
  return Object.values(input).some((value) => typeof value === "string" && /^\s*```/m.test(value));
}

/** The whole operation as plain text, for a file. */
export function operationFile(permission: Permission): string {
  const { tool, input, cwd } = permission;
  const fields = Object.entries(input).map(([name, value]) =>
    typeof value === "string"
      ? `--- ${name} ---\n${value}`
      : `--- ${name} ---\n${JSON.stringify(value)}`,
  );
  return [`${tool}, in ${cwd}`, ...fields, `ref ${permission.hash}`].join("\n\n");
}

function block(body: string, lang = ""): string[] {
  return [`\`\`\`${lang}`, body, "```"];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
