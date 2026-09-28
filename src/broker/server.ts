import { chmodSync, rmSync } from "node:fs";

/** What the broker answers on its socket. */
export interface Routes {
  health(): unknown;
  /** Starts a pairing (plan 2.4): the answer holds the one-time code, for `ctl pair` to show. */
  pair(): unknown;
  hook(event: string, body: unknown): { readonly status: number; readonly body: unknown };
}

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
  const server = Bun.serve({ unix: socket, fetch: (request) => route(request, routes) });
  chmodSync(socket, 0o600);
  return server;
}

async function route(request: Request, routes: Routes): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") return Response.json(routes.health());
  if (request.method === "POST" && pathname === "/pair") return Response.json(routes.pair());
  const event = /^\/hook\/([A-Za-z]{1,40})$/.exec(pathname)?.[1];
  if (request.method === "POST" && event !== undefined) {
    const { status, body } = routes.hook(event, await readJson(request));
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
