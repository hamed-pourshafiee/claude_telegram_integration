import { chmodSync, rmSync } from "node:fs";
import type { Answer } from "./answer.ts";

/** What the broker answers on its socket. */
export interface Routes {
  health(): unknown;
  /** Starts a pairing (plan 2.4): the answer holds the one-time code, for `ctl pair` to show. */
  pair(): unknown;
  /** A hook's call; a waiting Stop hook's Wait is answered later (plan 3.1). */
  hook(event: string, body: unknown): Answer | Promise<Answer>;
}

/** Seconds a connection may stay quiet: longer than a Wait is held (25 s), under Bun's cap of 255. */
const IDLE_SECONDS = 60;

/** macOS allows 104 bytes for a Unix socket path, the final NUL included. */
const MAX_SOCKET_PATH = 103;

/**
 * Serves the broker's HTTP API on its Unix socket (0600); there is no TCP port (design §5). A socket
 * file left by a crash is replaced, which is safe because the caller holds the single-instance lock.
 */
export function startServer(socket: string, routes: Routes): Bun.Server<undefined> {
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH) {
    throw new Error(
      `the socket path is ${bytes} bytes, over macOS's ${MAX_SOCKET_PATH}: move the repo`,
    );
  }
  rmSync(socket, { force: true });
  // Bun 1.4.1 cuts a request on a Unix socket after 10 s unless idleTimeout says otherwise, which would
  // cut a held Wait; its types allow idleTimeout only for TCP, hence the cast (tested in plan 3.1).
  const options = {
    unix: socket,
    idleTimeout: IDLE_SECONDS,
    fetch: (request: Request) => route(request, routes),
  };
  const server = Bun.serve(options as unknown as Parameters<typeof Bun.serve<undefined>>[0]);
  chmodSync(socket, 0o600);
  return server;
}

async function route(request: Request, routes: Routes): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") return Response.json(routes.health());
  if (request.method === "POST" && pathname === "/pair") return Response.json(routes.pair());
  const event = /^\/hook\/([A-Za-z]{1,40})$/.exec(pathname)?.[1];
  if (request.method === "POST" && event !== undefined) {
    const { status, body } = await routes.hook(event, await readJson(request));
    return Response.json(body, { status });
  }
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}

/** The request's JSON body, or undefined when it isn't JSON. */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // the route answers 400; the body may be Claude's text, so it isn't logged
  }
}
