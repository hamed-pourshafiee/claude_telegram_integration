import { join, resolve } from "node:path";

// Every path comes from this file's location, never from the session's current directory (design §3).
export const REPO_ROOT: string = resolve(import.meta.dir, "../..");
export const ENV_FILE: string = join(REPO_ROOT, ".env");
export const CONFIG_FILE: string = join(REPO_ROOT, "config.json");
