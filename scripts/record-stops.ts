// Records real stops for the finish-detection tests (plan 2.8, flow 1, F16). Each scenario runs
// `claude -p` in a scratch folder with throwaway Stop hooks (throwaway-stop-hook.ts), loaded through
// --settings with --setting-sources project, so ~/.claude/settings.json is neither read nor changed.
// It keeps each transcript cut down to what the classifier reads, home paths masked, with every stop as
// its hooks saw it: tests/fixtures/transcripts/<version>/. It calls the Claude API, a few short turns.
//   bun scripts/record-stops.ts [path to claude]   (default: the VS Code extension's, else `claude`)
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { asFields, type Fields } from "../src/shared/json.ts";
import { REPO_ROOT } from "../src/shared/paths.ts";

process.on("unhandledRejection", (reason) => {
  console.error(`record-stops: ${String(reason)}`);
  process.exit(1);
});

interface Scenario {
  readonly name: string;
  /** Throwaway Stop hooks besides "record", which is always there. */
  readonly hooks: readonly string[];
  readonly prompts: readonly string[];
}

interface HookLine {
  readonly event: string;
  readonly session?: string;
  readonly transcript: string;
  readonly promptId?: string;
  readonly text?: string;
  readonly bytes: number;
}

const HI = "Say hi in one short sentence.";
const DONE = "Reply with exactly this and nothing else: Done.";
const SCENARIOS: readonly Scenario[] = [
  { name: "block", hooks: ["block"], prompts: [HI] },
  { name: "block-twice", hooks: ["block2"], prompts: [HI] },
  { name: "context", hooks: ["context"], prompts: [HI] },
  { name: "crash", hooks: ["crash"], prompts: [HI] },
  { name: "prevented", hooks: ["block", "prevent"], prompts: [HI] },
  { name: "same-text", hooks: [], prompts: [DONE, DONE] },
  { name: "same-text-block", hooks: ["block"], prompts: [DONE, DONE] },
];
const HOOK = join(REPO_ROOT, "scripts", "throwaway-stop-hook.ts");
/** Fields of an entry kept in a fixture: what the classifier reads, and what shows the chain. */
const KEPT = [
  "type",
  "subtype",
  "uuid",
  "parentUuid",
  "promptId",
  "isMeta",
  "timestamp",
  "preventedContinuation",
  "hookCount",
  "hookErrors",
  "level",
] as const;

function main(): void {
  const claude = process.argv[2] ?? defaultClaude();
  const version = /^(\d+\.\d+\.\d+)/.exec(run([claude, "--version"], tmpdir()))?.[1];
  if (version === undefined) throw new Error(`no version from ${claude}`);
  const out = join(REPO_ROOT, "tests", "fixtures", "transcripts", version);
  mkdirSync(out, { recursive: true });
  for (const scenario of SCENARIOS) {
    const fixture = record(claude, scenario, version);
    writeFileSync(join(out, `${scenario.name}.jsonl`), fixture.jsonl);
    writeFileSync(
      join(out, `${scenario.name}.json`),
      `${JSON.stringify(fixture.facts, null, 2)}\n`,
    );
    console.log(`${version} ${scenario.name}: ${fixture.summary}`);
  }
}

/** Runs the scenario's prompts in one session and returns its fixture. */
function record(claude: string, scenario: Scenario, version: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `stops-${scenario.name}-`)));
  try {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: hooksFor(scenario, dir) }));
    let session: string | undefined;
    for (const prompt of scenario.prompts) {
      const resume = session === undefined ? [] : ["--resume", session];
      const base = ["-p", prompt, "--settings", settings, "--setting-sources", "project"];
      run([claude, ...base, ...resume], dir);
      session ??= hookLines(dir)[0]?.session;
    }
    const lines = hookLines(dir);
    const paths = new Set(lines.map((line) => line.transcript).filter((path) => path !== ""));
    const [path] = paths;
    if (path === undefined || paths.size > 1)
      throw new Error(`${scenario.name}: transcripts ${paths.size}`);
    const raw = readFileSync(path);
    removeTranscript(path, scenario.name);
    return fixture(scenario, version, lines, raw, masker(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hooksFor(scenario: Scenario, dir: string): Record<string, unknown> {
  const hook = (behavior: string) => ({
    hooks: [
      {
        type: "command",
        command: `${process.execPath} --no-env-file ${HOOK} ${behavior} ${dir}`,
        timeout: 30,
      },
    ],
  });
  return {
    UserPromptSubmit: [hook("record")],
    Stop: [hook("record"), ...scenario.hooks.map(hook)],
  };
}

function fixture(
  scenario: Scenario,
  version: string,
  lines: readonly HookLine[],
  raw: Buffer,
  mask: (text: string) => string,
) {
  const entries = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => reduce(asFields(JSON.parse(line)) ?? {}));
  const stops = stopsOf(lines, raw);
  const finishes = stops.filter((stop) => stop.truth === "finish").length;
  if (finishes !== scenario.prompts.length)
    throw new Error(`${scenario.name}: ${finishes} finishes`);
  const facts = { claudeCode: version, scenario: scenario.name, hooks: scenario.hooks, stops };
  return {
    jsonl: mask(entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")),
    facts: JSON.parse(mask(JSON.stringify(facts))),
    summary: stops.map((stop) => `${stop.truth} at ${stop.entriesAtStart}`).join(", "),
  };
}

/** Each Stop the hooks saw; the last stop of a prompt is its real finish, the others continued. */
function stopsOf(lines: readonly HookLine[], raw: Buffer) {
  let prompt = 0;
  const stops = lines.flatMap((line) => {
    if (line.event === "UserPromptSubmit") prompt += 1;
    if (line.event !== "Stop") return [];
    // Complete lines when the hook started; the summary comes after the synchronous Stop hooks.
    const entriesAtStart = raw.subarray(0, line.bytes).toString("utf8").split("\n").length - 1;
    return [{ prompt, promptId: line.promptId, text: line.text ?? "", entriesAtStart }];
  });
  return stops.map((stop, index) => ({
    ...stop,
    truth: stops[index + 1]?.prompt === stop.prompt ? "continuing" : "finish",
  }));
}

/** An entry with only the kept fields; message content keeps text, other blocks only their type. */
function reduce(entry: Fields): Fields {
  const kept: Record<string, unknown> = {};
  for (const key of KEPT) if (entry[key] !== undefined) kept[key] = entry[key];
  const message = asFields(entry.message);
  if (message !== undefined) {
    kept.message = { id: message.id, role: message.role, content: reduceContent(message.content) };
  }
  const attachment = asFields(entry.attachment);
  if (attachment !== undefined) {
    kept.attachment = { type: attachment.type, hookEvent: attachment.hookEvent };
  }
  return kept;
}

function reduceContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const blocks: readonly unknown[] = content;
  return blocks.map((block) => {
    const fields = asFields(block) ?? {};
    if (fields.type === "text") return { type: "text", text: fields.text };
    if (fields.type === "tool_use") return { type: "tool_use", name: fields.name };
    return { type: fields.type };
  });
}

function masker(dir: string): (text: string) => string {
  const home = homedir();
  const user = basename(home);
  return (text) =>
    text
      .replaceAll(dir, "<scratch>")
      .replaceAll(home, "~")
      .replaceAll(`-Users-${user}-`, "-Users-USER-");
}

function hookLines(dir: string): HookLine[] {
  const file = join(dir, "hooks.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): HookLine => JSON.parse(line));
}

/** The scratch session's transcript, once read; only a folder named after our scratch folder. */
function removeTranscript(path: string, name: string): void {
  const folder = dirname(path);
  if (!basename(folder).includes(`-stops-${name}-`)) throw new Error(`not ours: ${folder}`);
  rmSync(folder, { recursive: true, force: true });
}

function run(command: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 2).join(" ")} exit ${result.exitCode}: ${result.stderr}`);
  }
  return result.stdout.toString();
}

function defaultClaude(): string {
  const extensions = join(homedir(), ".vscode", "extensions");
  const found = existsSync(extensions)
    ? readdirSync(extensions).filter((name) => name.startsWith("anthropic.claude-code-"))
    : [];
  const latest = found.sort().at(-1);
  return latest === undefined
    ? "claude"
    : join(extensions, latest, "resources", "native-binary", "claude");
}

main();
