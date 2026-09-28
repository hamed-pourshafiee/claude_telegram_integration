/**
 * A structured log event. Its fields hold ids, sizes and timings, never message text or secrets
 * (design §5). Only plain values are allowed, so an object that carries a URL can't slip in.
 */
export type LogFields = Readonly<Record<string, string | number | boolean>> & {
  // The names every log line has already: a field of the same name would overwrite them.
  readonly t?: never;
  readonly source?: never;
  readonly pid?: never;
  readonly event?: never;
};
export type Log = (event: string, fields: LogFields) => void;

/** For callers that don't log. */
export const noLog: Log = () => undefined;
