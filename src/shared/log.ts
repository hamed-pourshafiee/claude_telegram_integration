/**
 * A structured log event. Its fields hold ids, sizes and timings, never message text or secrets
 * (design §5). Only plain values are allowed, so an object that carries a URL can't slip in.
 */
export type LogFields = Readonly<Record<string, string | number | boolean>>;
export type Log = (event: string, fields: LogFields) => void;

/** For callers that don't log. */
export const noLog: Log = () => undefined;
