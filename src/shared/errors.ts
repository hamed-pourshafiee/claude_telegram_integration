import { asFields } from "./json.ts";

/**
 * A setup problem the user fixes by hand, in .env, config.json or the environment. The message says
 * what is wrong and how to fix it, and never contains a secret.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** An error's message, for logs and reports; our own errors never carry a secret. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error's code, such as ConnectionRefused or ENOENT, when it looks like one; otherwise its name. */
export function errorCode(error: unknown): string {
  const code = asFields(error)?.code;
  if (typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown";
}
