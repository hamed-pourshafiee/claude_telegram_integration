import { asFields } from "../shared/json.ts";

/** A family of secrets: how to find one. A named group `keep` is kept in front of the mask. */
interface Family {
  readonly name: string;
  readonly pattern: RegExp;
}

// None of these relies on \b (plan 2.5). A bot token follows "bot" directly in a Bot API URL and may
// end in "-", and "sk-" must not match inside "task-notification", so look-behinds say where a secret
// may start. Families run in order: the specific ones first, the "KEY=value" lines last.
const FAMILIES: readonly Family[] = [
  {
    name: "private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: "JWT", pattern: /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },
  { name: "Telegram bot token", pattern: /(?<![0-9])[0-9]{6,12}:[\w-]{30,}/g },
  { name: "sk- key", pattern: /(?<![\w-])sk-[\w-]{20,}/g },
  { name: "AWS key", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g },
  { name: "Google API key", pattern: /(?<![\w-])AIza[\w-]{35}/g },
  { name: "GitLab token", pattern: /(?<![\w-])glpat-[\w-]{20,}/g },
  { name: "GitHub token", pattern: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/g },
  { name: "Slack token", pattern: /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // An explicit Authorization (or Proxy-Authorization) header: its credential, however short
  {
    name: "authorization token",
    pattern:
      /(?<keep>Authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:Bearer|Basic|Token|Bot|Digest)[ \t]+)?)(?![\s[]|(?:Bearer|Basic|Token|Bot|Digest)[ \t])[^\s"',]+/gi,
  },
  // A long credential after "Bearer" or "Basic" (base64 of user:password) anywhere else
  {
    name: "authorization token",
    pattern: /(?<keep>(?<![\w-])(?:Bearer|Basic)\s+)[\w.~+/=-]{16,}/gi,
  },
  // A line that starts with a secret-looking name: API_KEY=..., export DB_PASSWORD="...",
  // "password": "...", token: .... A quoted value is masked up to its closing quote, spaces and
  // commas included; an unquoted one up to the end of the line. A value never starts with a space,
  // so that backtracking can't take " [redacted …]" as a value and mask it again.
  {
    name: "secret setting",
    pattern: new RegExp(
      String.raw`^(?<keep>${secretName()}(?<quote>["']))(?!\[)(?:(?!\k<quote>)[^\n])+(?=\k<quote>)`,
      "gim",
    ),
  },
  {
    name: "secret setting",
    pattern: new RegExp(
      String.raw`^(?<keep>${secretName()})(?![\s"'[]|(?:Bearer|Basic)\s)[^\n]*[^\s,]`,
      "gim",
    ),
  },
];

/** The start of a secret setting's line, up to its value: the name, then ":" or "=". */
function secretName(): string {
  const keywords =
    "PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH";
  return String.raw`[ \t]*(?:export[ \t]+)?["']?[\w.-]*(?:${keywords})[\w.-]*["']?[ \t]*[:=][ \t]*`;
}

/**
 * `text` with every secret of the families above replaced by "[redacted <family>]" (design §5, D8),
 * and how many were replaced. What the chat shows, and the full-text file, both come from this.
 */
export function redact(text: string): { readonly text: string; readonly count: number } {
  let count = 0;
  let result = text;
  for (const { name, pattern } of FAMILIES) {
    result = result.replace(pattern, (...args: unknown[]) => {
      count += 1;
      const keep = asFields(args.at(-1))?.keep;
      return `${typeof keep === "string" ? keep : ""}[redacted ${name}]`;
    });
  }
  return { text: result, count };
}
