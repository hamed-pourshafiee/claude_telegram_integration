// Plan 2.5's fixture: one fake sample of each secret family. Every sample is assembled at runtime, so
// no secret-shaped text sits in the source for a secret scan to trip over.

export interface Sample {
  readonly family: string;
  /** The line as it appears in a reply. */
  readonly line: string;
  /** The part that must not survive redaction. */
  readonly secret: string;
  /** A part that must survive, such as a setting's name. */
  readonly kept?: string;
}

const join = (...parts: string[]) => parts.join("");
const pem = join(
  "-----BEGIN RSA ",
  "PRIVATE KEY-----\nMIIEowIBAAKCAQEA",
  "x".repeat(40),
  "\n-----END RSA ",
  "PRIVATE KEY-----",
);
const jwt = join(
  "eyJ",
  "hbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiIxMjM0In0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
);
const botToken = join("8".repeat(10), ":", "AAG", "x".repeat(31), "-");
const skKey = join("sk-", "ant-api03-", "Z".repeat(30));
const aws = join("AKIA", "IOSFODNN7EXAMPLE");
const google = join("AIza", "S".repeat(35));
const gitlab = join("glpat-", "x".repeat(20));
const github = join("ghp_", "a".repeat(36));
const slack = join("xoxb-", "1234567890-", "abcdefghij");
const bearer = join("abc.def-ghi_jkl~mno", "+p/q=");
const basic = join("dXNlcjpwYXNz", "d29yZA==");
const apiKey = join("s3cr3tV4lue", "9");
const password = join("hunter2", "hunter2");
const awsSecret = join("wJalrXUtnFEMI", "K7MDENG");

export const SAMPLES: readonly Sample[] = [
  { family: "private key", line: pem, secret: "MIIEowIBAAKCAQEA" },
  { family: "JWT", line: `session cookie ${jwt}`, secret: jwt },
  {
    family: "Telegram bot token",
    line: `curl https://api.telegram.org/bot${botToken}/getMe`,
    secret: botToken.slice(11),
    kept: "https://api.telegram.org/bot",
  },
  {
    family: "sk- key",
    line: `ANTHROPIC key ${skKey} in a task-notification`,
    secret: skKey,
    kept: "task-notification",
  },
  { family: "AWS key", line: `aws_access_key_id ${aws}`, secret: aws },
  { family: "Google API key", line: `maps key=${google}`, secret: google },
  {
    family: "GitLab token",
    line: `git clone https://oauth2:${gitlab}@gitlab.com/x.git`,
    secret: gitlab,
  },
  { family: "GitHub token", line: `gh auth login --with-token ${github}`, secret: github },
  { family: "Slack token", line: `SLACK ${slack}`, secret: slack },
  {
    family: "authorization token",
    line: `Authorization: Bearer ${bearer}`,
    secret: bearer,
    kept: "Authorization: Bearer ",
  },
  {
    family: "authorization token",
    line: `curl -H "Authorization: Basic ${basic}" https://example.com`,
    secret: basic,
    kept: "Authorization: Basic ",
  },
  { family: "secret setting", line: `API_KEY=${apiKey}`, secret: apiKey, kept: "API_KEY=" },
  {
    family: "secret setting",
    line: `  "password": "${password}",`,
    secret: password,
    kept: '"password": "',
  },
  {
    family: "secret setting",
    line: `export AWS_SECRET_ACCESS_KEY=${awsSecret}`,
    secret: awsSecret,
    kept: "export AWS_SECRET_ACCESS_KEY=",
  },
];
