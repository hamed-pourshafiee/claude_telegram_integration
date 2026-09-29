/** What a hook call gets back from the broker: an HTTP status and a JSON body. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export function ok(fields: object): Answer {
  return { status: 200, body: { ok: true, pid: process.pid, ...fields } };
}

export function bad(error: string): Answer {
  return { status: 400, body: { ok: false, error } };
}
