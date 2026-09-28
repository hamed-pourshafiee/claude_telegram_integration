import { chmodSync, rmSync } from "node:fs";
import { asFields } from "../shared/json.ts";
import type { Log } from "../shared/log.ts";

export interface BrokerInfo {
  readonly pid: number;
  readonly startedAt: Date;
  /** The public part of the token: the bot's user id. */
  readonly botId: number;
  /** Secret.fingerprint() of the token, so ctl can tell whether .env still holds the same one. */
  readonly tokenFingerprint: string;
  readonly schema: number;
}

/** macOS allows 104 bytes for a Unix socket path, the final NUL included. */
const MAX_SOCKET_PATH = 103;

/**
 * Serves the broker's HTTP API on its Unix socket (0600); there is no TCP port (design §5). A socket
 * file left by a crash is replaced, which is safe because the caller holds the single-instance lock.
 */
export function startServer(socket: string, info: BrokerInfo, log: Log): Bun.Server<undefined> {
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH) {
    throw new Error(
      `the socket path is ${bytes} bytes, over macOS's ${MAX_SOCKET_PATH}: move the repo`,
    );
  }
  rmSync(socket, { force: true });
  const server = Bun.serve({ unix: socket, fetch: (request) => route(request, info, log) });
  chmodSync(socket, 0o600);
  return server;
}

async function route(request: Request, info: BrokerInfo, log: Log): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") return Response.json(health(info));
  const event = /^\/hook\/([A-Za-z]{1,40})$/.exec(pathname)?.[1];
  if (request.method === "POST" && event !== undefined) {
    return hookEvent(event, await readJson(request), info, log);
  }
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

export function health(info: BrokerInfo) {
  return {
    ok: true,
    pid: info.pid,
    startedAt: info.startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - info.startedAt.getTime()) / 1000),
    botId: info.botId,
    tokenFingerprint: info.tokenFingerprint,
    schema: info.schema,
    envKeys: Object.keys(process.env).sort(),
  };
}

/** Plan 2.3: a hook reached the broker, which logs it. Later steps handle each event. */
function hookEvent(event: string, body: unknown, info: BrokerInfo, log: Log): Response {
  const session = asFields(body)?.session_id;
  if (typeof session !== "string") {
    return Response.json({ ok: false, error: "no session_id" }, { status: 400 });
  }
  log("hook.event", { hook: event, session });
  return Response.json({ ok: true, pid: info.pid });
}

/** The request's JSON body, or undefined when it isn't JSON (answered as a missing session_id). */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // hookEvent answers 400; the body may be Claude's text, so it isn't logged
  }
}
