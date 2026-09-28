/**
 * A setup problem the user fixes by hand, in .env or config.json. The message says what is wrong and
 * how to fix it, and never contains a secret.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}
